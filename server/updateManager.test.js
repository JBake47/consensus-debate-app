import assert from 'node:assert/strict';
import {
  canAutoStashDirtyEntries,
  getDependencyInstallMode,
  isBlockingManifestDirtyEntry,
  isManifestDirtyEntry,
  isUnmergedGitStatus,
  manifestChangeNeedsDependencyInstall,
  needsAppRestart,
  needsDependencyInstall,
  needsPageReload,
  parseGitStatusPorcelain,
} from './updateManager.js';

function runTest(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

runTest('parseGitStatusPorcelain captures tracked and untracked files', () => {
  const entries = parseGitStatusPorcelain([
    ' M package.json',
    'M  src/context/DebateContext.jsx',
    '?? server/updateManager.js',
  ].join('\n'));

  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    indexStatus: ' ',
    worktreeStatus: 'M',
    path: 'package.json',
  });
  assert.deepEqual(entries[2], {
    indexStatus: '?',
    worktreeStatus: '?',
    path: 'server/updateManager.js',
  });
});

runTest('unmerged git statuses are treated as hard blockers', () => {
  assert.equal(isUnmergedGitStatus({ indexStatus: 'U', worktreeStatus: 'U' }), true);
  assert.equal(isUnmergedGitStatus({ indexStatus: 'A', worktreeStatus: 'A' }), true);
  assert.equal(isUnmergedGitStatus({ indexStatus: ' ', worktreeStatus: 'M' }), false);
});

runTest('auto-stash only allows ordinary dirty entries', () => {
  assert.equal(canAutoStashDirtyEntries([]), false);
  assert.equal(canAutoStashDirtyEntries([
    { indexStatus: ' ', worktreeStatus: 'M', path: 'src/App.jsx' },
    { indexStatus: '?', worktreeStatus: '?', path: 'notes.txt' },
  ]), true);
  assert.equal(canAutoStashDirtyEntries([
    { indexStatus: ' ', worktreeStatus: 'M', path: 'package-lock.json' },
    { indexStatus: '?', worktreeStatus: '?', path: 'notes.txt' },
  ]), true);
  assert.equal(canAutoStashDirtyEntries([
    { indexStatus: 'M', worktreeStatus: ' ', path: 'package-lock.json' },
    { indexStatus: '?', worktreeStatus: '?', path: 'notes.txt' },
  ]), false);
  assert.equal(canAutoStashDirtyEntries([
    { indexStatus: 'U', worktreeStatus: 'U', path: 'package-lock.json' },
  ]), false);
  assert.equal(canAutoStashDirtyEntries([
    { indexStatus: ' ', worktreeStatus: 'M', path: 'package.json' },
  ]), false);
});

runTest('dependency manifests are treated as unsafe updater dirtiness', () => {
  assert.equal(isManifestDirtyEntry({ path: 'package-lock.json' }), true);
  assert.equal(isManifestDirtyEntry({ path: 'package.json' }), true);
  assert.equal(isManifestDirtyEntry({ path: 'src/App.jsx' }), false);
});

runTest('worktree-only package-lock drift stays auto-stashable while intentional manifest edits still block', () => {
  assert.equal(isBlockingManifestDirtyEntry({
    indexStatus: ' ',
    worktreeStatus: 'M',
    path: 'package-lock.json',
  }), false);
  assert.equal(isBlockingManifestDirtyEntry({
    indexStatus: 'M',
    worktreeStatus: ' ',
    path: 'package-lock.json',
  }), true);
  assert.equal(isBlockingManifestDirtyEntry({
    indexStatus: ' ',
    worktreeStatus: 'M',
    path: 'package.json',
  }), true);
});

runTest('dependency install candidate detection only flags manifests', () => {
  assert.equal(needsDependencyInstall(['src/App.jsx']), false);
  assert.equal(needsDependencyInstall(['package.json']), true);
  assert.equal(needsDependencyInstall(['docs/readme.md', 'package-lock.json']), true);
});

runTest('version-only release metadata does not force dependency refresh', () => {
  const previousPackage = {
    name: 'consensus',
    private: true,
    version: '0.3.37',
    scripts: { build: 'vite build' },
    dependencies: { express: '^4.19.2' },
    devDependencies: { vite: '^6.0.1' },
  };
  const currentPackage = {
    ...previousPackage,
    version: '0.3.38',
    scripts: { build: 'vite build --mode production' },
  };

  const previousLockfile = {
    name: 'consensus',
    version: '0.3.37',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'consensus',
        version: '0.3.37',
        dependencies: { express: '^4.19.2' },
      },
      'node_modules/express': {
        version: '4.19.2',
        resolved: 'https://registry.npmjs.org/express/-/express-4.19.2.tgz',
      },
    },
  };
  const currentLockfile = {
    ...previousLockfile,
    version: '0.3.38',
    packages: {
      ...previousLockfile.packages,
      '': {
        ...previousLockfile.packages[''],
        version: '0.3.38',
      },
    },
  };

  assert.equal(manifestChangeNeedsDependencyInstall('package.json', previousPackage, currentPackage), false);
  assert.equal(manifestChangeNeedsDependencyInstall('package-lock.json', previousLockfile, currentLockfile), false);
});

runTest('dependency graph changes still force dependency refresh', () => {
  const previousPackage = {
    dependencies: { express: '^4.19.2' },
    devDependencies: { vite: '^6.0.1' },
  };
  const currentPackage = {
    dependencies: { express: '^4.19.2', dotenv: '^16.4.7' },
    devDependencies: { vite: '^6.0.1' },
  };
  const previousLockfile = {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { express: '^4.19.2' },
      },
    },
  };
  const currentLockfile = {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { express: '^4.19.2', dotenv: '^16.4.7' },
      },
      'node_modules/dotenv': {
        version: '16.4.7',
      },
    },
  };

  assert.equal(manifestChangeNeedsDependencyInstall('package.json', previousPackage, currentPackage), true);
  assert.equal(manifestChangeNeedsDependencyInstall('package-lock.json', previousLockfile, currentLockfile), true);
});

runTest('dependency refresh prefers npm ci when a lockfile exists', () => {
  assert.equal(getDependencyInstallMode({ hasPackageLock: true }), 'ci');
  assert.equal(getDependencyInstallMode({ hasShrinkwrap: true }), 'ci');
  assert.equal(getDependencyInstallMode({ hasPackageLock: false, hasShrinkwrap: false }), 'install');
});

runTest('restart detection catches backend and config changes', () => {
  assert.equal(needsAppRestart(['src/App.jsx']), false);
  assert.equal(needsAppRestart(['server/index.js']), true);
  assert.equal(needsAppRestart(['vite.config.js']), true);
});

runTest('page reload detection catches frontend changes', () => {
  assert.equal(needsPageReload(['README.md']), false);
  assert.equal(needsPageReload(['public/logo.svg']), true);
  assert.equal(needsPageReload(['src/components/SettingsModal.jsx']), true);
});

// eslint-disable-next-line no-console
console.log('Update manager tests completed.');
