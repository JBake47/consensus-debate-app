import assert from 'node:assert/strict';
import {
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

runTest('dependency install only runs when manifests change', () => {
  assert.equal(needsDependencyInstall(['src/App.jsx']), false);
  assert.equal(needsDependencyInstall(['package.json']), true);
  assert.equal(needsDependencyInstall(['docs/readme.md', 'package-lock.json']), true);
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
