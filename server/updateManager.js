import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const GIT_COMMAND = process.platform === 'win32' ? 'git.exe' : 'git';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MANIFEST_FILES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
];
const UNMERGED_STATUS_CODES = new Set([
  'DD',
  'AU',
  'UD',
  'UA',
  'DU',
  'AA',
  'UU',
]);

const INSTALL_TRIGGER_FILES = new Set(MANIFEST_FILES);
const PACKAGE_INSTALL_RELEVANT_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
  'overrides',
  'resolutions',
  'packageManager',
  'engines',
  'os',
  'cpu',
  'workspaces',
];

const RESTART_TRIGGER_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
]);

let activeUpdatePromise = null;

export class AppUpdateError extends Error {
  constructor(message, status = 500, code = 'update_failed') {
    super(message);
    this.name = 'AppUpdateError';
    this.status = status;
    this.code = code;
  }
}

function normalizeOutput(value) {
  return String(value || '').trimEnd();
}

function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count) === 1 ? singular : plural;
}

async function runCommand(command, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    return {
      stdout: normalizeOutput(stdout),
      stderr: normalizeOutput(stderr),
      error: null,
    };
  } catch (error) {
    const stdout = normalizeOutput(error?.stdout);
    const stderr = normalizeOutput(error?.stderr);
    if (allowFailure) {
      return {
        stdout,
        stderr,
        error,
      };
    }

    const detail = stderr || stdout || error?.message || `${command} failed`;
    throw new AppUpdateError(detail, 500, 'command_failed');
  }
}

async function runGit(args, options) {
  return runCommand(GIT_COMMAND, args, options);
}

async function runNpm(args, options) {
  return runCommand(NPM_COMMAND, args, options);
}

async function readPackageVersion(cwd) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    return String(packageJson?.version || '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseAheadBehind(output = '') {
  const [aheadRaw = '0', behindRaw = '0'] = normalizeOutput(output).split(/\s+/);
  const aheadCount = Number.parseInt(aheadRaw, 10);
  const behindCount = Number.parseInt(behindRaw, 10);
  return {
    aheadCount: Number.isFinite(aheadCount) ? Math.max(0, aheadCount) : 0,
    behindCount: Number.isFinite(behindCount) ? Math.max(0, behindCount) : 0,
  };
}

export function parseGitStatusPorcelain(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      indexStatus: line[0] || ' ',
      worktreeStatus: line[1] || ' ',
      path: normalizeGitStatusPath(line.slice(3)),
    }));
}

function normalizeGitStatusPath(rawPath = '') {
  const trimmed = String(rawPath || '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function summarizePaths(entries, limit = 6) {
  const paths = entries
    .map((entry) => String(entry?.path || '').trim())
    .filter(Boolean);
  if (paths.length <= limit) return paths;
  return [
    ...paths.slice(0, limit),
    `+${paths.length - limit} more`,
  ];
}

export function isUnmergedGitStatus(entry = {}) {
  const indexStatus = String(entry?.indexStatus || ' ').slice(0, 1) || ' ';
  const worktreeStatus = String(entry?.worktreeStatus || ' ').slice(0, 1) || ' ';
  return UNMERGED_STATUS_CODES.has(`${indexStatus}${worktreeStatus}`);
}

export function isManifestDirtyEntry(entry = {}) {
  return INSTALL_TRIGGER_FILES.has(String(entry?.path || '').trim());
}

export function isBlockingManifestDirtyEntry(entry = {}) {
  const normalizedPath = String(entry?.path || '').trim();
  if (!INSTALL_TRIGGER_FILES.has(normalizedPath)) {
    return false;
  }

  if (normalizedPath !== 'package-lock.json') {
    return true;
  }

  const indexStatus = String(entry?.indexStatus || ' ').slice(0, 1) || ' ';
  const worktreeStatus = String(entry?.worktreeStatus || ' ').slice(0, 1) || ' ';
  return !(indexStatus === ' ' && worktreeStatus === 'M');
}

function isUntrackedGitStatus(entry = {}) {
  const indexStatus = String(entry?.indexStatus || ' ').slice(0, 1) || ' ';
  const worktreeStatus = String(entry?.worktreeStatus || ' ').slice(0, 1) || ' ';
  return indexStatus === '?' && worktreeStatus === '?';
}

export function canAutoStashDirtyEntries(entries = []) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  return normalizedEntries.length > 0
    && !normalizedEntries.some((entry) => isUnmergedGitStatus(entry) || isBlockingManifestDirtyEntry(entry));
}

export function getDependencyInstallMode({ hasPackageLock = false, hasShrinkwrap = false } = {}) {
  return hasPackageLock || hasShrinkwrap ? 'ci' : 'install';
}

function buildBlockedReason({ dirtyEntries, hasUpstream, aheadCount, behindCount, updateInProgress }) {
  if (updateInProgress) {
    return 'Another update is already running.';
  }

  const conflictingEntries = dirtyEntries.filter(isUnmergedGitStatus);
  if (conflictingEntries.length > 0) {
    const dirtySummary = summarizePaths(conflictingEntries).join(', ');
    return `Update blocked because the working tree has unresolved conflicts: ${dirtySummary}`;
  }

  if (!hasUpstream) {
    return 'Update blocked because this branch has no upstream tracking branch.';
  }

  if (aheadCount > 0 && behindCount > 0) {
    return 'Update blocked because the local branch has diverged from upstream. Reconcile it manually first.';
  }

  if (behindCount > 0) {
    const manifestEntries = dirtyEntries.filter(isBlockingManifestDirtyEntry);
    if (manifestEntries.length > 0) {
      const dirtySummary = summarizePaths(manifestEntries).join(', ');
      return `Update blocked because dependency manifests have local changes: ${dirtySummary}. Commit or discard them before updating.`;
    }
  }

  return null;
}

function appendDirtyStatus(message, dirtyEntries, { autoStashEligible = false } = {}) {
  if (dirtyEntries.length === 0) {
    return message;
  }

  const dirtySummary = summarizePaths(dirtyEntries).join(', ');
  if (!dirtySummary) {
    return message;
  }

  if (autoStashEligible) {
    return `${message} Local changes are present (${dirtySummary}) and will be stashed and restored automatically during updates.`;
  }

  return `${message} Local changes are present: ${dirtySummary}.`;
}

export function needsDependencyInstall(changedFiles = []) {
  return changedFiles.some((file) => INSTALL_TRIGGER_FILES.has(String(file || '').trim()));
}

function cloneJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortJsonValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function stableJsonStringify(value) {
  return JSON.stringify(sortJsonValue(value));
}

export function normalizePackageManifestForInstallCheck(manifest = {}) {
  const source = cloneJsonObject(manifest);
  return PACKAGE_INSTALL_RELEVANT_KEYS.reduce((acc, key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      acc[key] = source[key];
    }
    return acc;
  }, {});
}

export function normalizePackageLockForInstallCheck(lockfile = {}) {
  const normalized = cloneJsonObject(lockfile);
  delete normalized.name;
  delete normalized.version;

  if (
    normalized.packages
    && typeof normalized.packages === 'object'
    && normalized.packages['']
    && typeof normalized.packages[''] === 'object'
  ) {
    delete normalized.packages[''].name;
    delete normalized.packages[''].version;
  }

  return normalized;
}

export function manifestChangeNeedsDependencyInstall(file, previousManifest, currentManifest) {
  const normalizedFile = String(file || '').trim();
  if (!INSTALL_TRIGGER_FILES.has(normalizedFile)) {
    return false;
  }

  if (
    !previousManifest
    || typeof previousManifest !== 'object'
    || !currentManifest
    || typeof currentManifest !== 'object'
  ) {
    return true;
  }

  const normalize = normalizedFile === 'package.json'
    ? normalizePackageManifestForInstallCheck
    : normalizePackageLockForInstallCheck;

  return stableJsonStringify(normalize(previousManifest)) !== stableJsonStringify(normalize(currentManifest));
}

async function readJsonFileAtRef(cwd, ref, file) {
  const result = await runGit(['show', `${ref}:${file}`], { cwd, allowFailure: true });
  if (result.error) {
    return {
      ok: false,
      value: null,
      detail: result.stderr || result.stdout || result.error?.message || `Unable to read ${file} at ${ref}`,
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(result.stdout),
      detail: '',
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      detail: error?.message || `Unable to parse ${file} at ${ref}`,
    };
  }
}

export async function needsDependencyInstallForUpdate({
  cwd = process.cwd(),
  changedFiles = [],
  previousCommit = '',
  currentCommit = '',
} = {}) {
  const changedManifestFiles = changedFiles
    .map((file) => String(file || '').trim())
    .filter((file) => INSTALL_TRIGGER_FILES.has(file));

  if (changedManifestFiles.length === 0) {
    return false;
  }

  if (!previousCommit || !currentCommit) {
    return true;
  }

  for (const file of changedManifestFiles) {
    const [previousResult, currentResult] = await Promise.all([
      readJsonFileAtRef(cwd, previousCommit, file),
      readJsonFileAtRef(cwd, currentCommit, file),
    ]);

    if (!previousResult.ok || !currentResult.ok) {
      return true;
    }

    if (manifestChangeNeedsDependencyInstall(file, previousResult.value, currentResult.value)) {
      return true;
    }
  }

  return false;
}

export function needsAppRestart(changedFiles = []) {
  return changedFiles.some((file) => {
    const normalized = String(file || '').trim();
    return normalized.startsWith('server/') || RESTART_TRIGGER_FILES.has(normalized);
  });
}

export function needsPageReload(changedFiles = []) {
  return changedFiles.some((file) => {
    const normalized = String(file || '').trim();
    return normalized === 'index.html'
      || normalized.startsWith('src/')
      || normalized.startsWith('public/');
  });
}

function buildUpdateSummary({
  updated,
  installRan,
  installMode,
  restartRequired,
  reloadRecommended,
  previousCommitShort,
  currentCommitShort,
  localChangesStashed,
  localChangesRestored,
  localChangesRequireManualRestore,
  stashRef,
}) {
  if (!updated) {
    const messages = ['App is already up to date.'];
    if (localChangesRestored) {
      messages.push('Local changes were restored.');
    } else if (localChangesStashed || localChangesRequireManualRestore) {
      messages.push(
        stashRef
          ? `Local changes still need manual restoration from ${stashRef}.`
          : 'Local changes still need manual restoration.',
      );
    }
    return messages.join(' ');
  }

  const messages = [
    `Updated ${previousCommitShort || 'current commit'} to ${currentCommitShort || 'latest commit'}.`,
  ];

  if (installRan) {
    messages.push(`Dependencies were refreshed with npm ${installMode || 'install'}.`);
  }

  if (restartRequired) {
    messages.push('Restart the app to load backend or dependency changes.');
  } else if (reloadRecommended) {
    messages.push('Refresh the page if the UI does not reload automatically.');
  } else {
    messages.push('No restart should be required.');
  }

  if (localChangesRestored) {
    messages.push('Local changes were restored after the update.');
  } else if (localChangesStashed || localChangesRequireManualRestore) {
    messages.push(
      stashRef
        ? `Local changes still need manual restoration from ${stashRef}.`
        : 'Local changes still need manual restoration.',
    );
  }

  return messages.join(' ');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getDependencyInstallArgs(cwd) {
  const [hasPackageLock, hasShrinkwrap] = await Promise.all([
    pathExists(path.join(cwd, 'package-lock.json')),
    pathExists(path.join(cwd, 'npm-shrinkwrap.json')),
  ]);
  const installMode = getDependencyInstallMode({ hasPackageLock, hasShrinkwrap });
  return {
    installMode,
    args: [installMode, '--no-audit', '--no-fund'],
  };
}

async function getManifestDrift(cwd) {
  const statusResult = await runGit([
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--',
    ...MANIFEST_FILES,
  ], { cwd });
  return parseGitStatusPorcelain(statusResult.stdout);
}

async function stashLocalChanges(cwd, dirtyEntries = []) {
  if (!canAutoStashDirtyEntries(dirtyEntries)) {
    return null;
  }

  const label = `app-update-autostash ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
  await runGit(['stash', 'push', '--include-untracked', '--message', label], { cwd });

  const topStashResult = await runGit(['stash', 'list', '-1', '--format=%gd\t%gs'], { cwd, allowFailure: true });
  const [stashRefRaw = 'stash@{0}'] = String(topStashResult.stdout || '').split('\t');
  const stashRef = stashRefRaw.trim() || 'stash@{0}';

  const statusAfterStash = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd });
  const remainingDirtyEntries = parseGitStatusPorcelain(statusAfterStash.stdout);
  if (remainingDirtyEntries.length > 0) {
    const dirtySummary = summarizePaths(remainingDirtyEntries).join(', ');
    throw new AppUpdateError(
      `Update blocked because local changes could not be stashed cleanly: ${dirtySummary}`,
      409,
      'update_stash_failed',
    );
  }

  return {
    ref: stashRef,
    dirtyEntries,
  };
}

async function stashRefExists(cwd, stashRef) {
  if (!stashRef) {
    return false;
  }

  const result = await runGit(['rev-parse', '--verify', '--quiet', stashRef], { cwd, allowFailure: true });
  return !result.error;
}

function resolveRepoPath(cwd, repoPath) {
  const rootPath = path.resolve(cwd);
  const targetPath = path.resolve(rootPath, String(repoPath || ''));
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new AppUpdateError(`Refusing to remove path outside the repository: ${repoPath}`, 500, 'update_restore_cleanup_failed');
  }
  return targetPath;
}

async function cleanupFailedRestore(cwd) {
  const cleanupMessages = [];
  const resetResult = await runGit(['reset', '--hard', 'HEAD'], { cwd, allowFailure: true });
  if (resetResult.error) {
    cleanupMessages.push(resetResult.stderr || resetResult.stdout || resetResult.error?.message || 'git reset --hard HEAD failed');
  }

  const statusAfterReset = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd, allowFailure: true });
  if (statusAfterReset.error) {
    cleanupMessages.push(statusAfterReset.stderr || statusAfterReset.stdout || statusAfterReset.error?.message || 'git status failed during restore cleanup');
  }

  const entriesAfterReset = parseGitStatusPorcelain(statusAfterReset.stdout);
  const untrackedEntries = entriesAfterReset.filter(isUntrackedGitStatus);
  for (const entry of untrackedEntries) {
    try {
      await fs.rm(resolveRepoPath(cwd, entry.path), { recursive: true, force: true });
    } catch (error) {
      cleanupMessages.push(error?.message || `Failed to remove ${entry.path}`);
    }
  }

  const finalStatusResult = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd, allowFailure: true });
  if (finalStatusResult.error) {
    cleanupMessages.push(finalStatusResult.stderr || finalStatusResult.stdout || finalStatusResult.error?.message || 'git status failed after restore cleanup');
  }

  const remainingDirtyEntries = parseGitStatusPorcelain(finalStatusResult.stdout);
  return {
    cleaned: cleanupMessages.length === 0 && remainingDirtyEntries.length === 0,
    remainingDirtyEntries,
    detail: cleanupMessages.join(' ').trim(),
  };
}

async function restoreStashedChanges(cwd, stashContext) {
  if (!stashContext?.ref) {
    return {
      attempted: false,
      restored: false,
      conflicted: false,
      stashRef: null,
      detail: '',
      cleanupSucceeded: false,
      cleanupDetail: '',
    };
  }

  const applyResult = await runGit(['stash', 'apply', stashContext.ref], { cwd, allowFailure: true });
  if (!applyResult.error) {
    const dropResult = await runGit(['stash', 'drop', stashContext.ref], { cwd, allowFailure: true });
    if (dropResult.error) {
      return {
        attempted: true,
        restored: true,
        conflicted: false,
        stashRef: stashContext.ref,
        detail: dropResult.stderr || dropResult.stdout || dropResult.error?.message || 'git stash drop failed',
        cleanupSucceeded: false,
        cleanupDetail: '',
      };
    }
    return {
      attempted: true,
      restored: true,
      conflicted: false,
      stashRef: null,
      detail: applyResult.stdout || applyResult.stderr || '',
      cleanupSucceeded: false,
      cleanupDetail: '',
    };
  }

  const stashStillExists = await stashRefExists(cwd, stashContext.ref);
  const cleanupResult = await cleanupFailedRestore(cwd);
  return {
    attempted: true,
    restored: false,
    conflicted: true,
    stashRef: stashStillExists ? stashContext.ref : null,
    detail: applyResult.stderr || applyResult.stdout || applyResult.error?.message || 'git stash apply failed',
    cleanupSucceeded: cleanupResult.cleaned,
    cleanupDetail: cleanupResult.detail,
  };
}

async function collectRepoStatus(cwd, { refresh = false, updateInProgressOverride = null } = {}) {
  await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });

  const [
    version,
    branchResult,
    currentCommitResult,
    currentCommitShortResult,
    statusResult,
    upstreamResult,
  ] = await Promise.all([
    readPackageVersion(cwd),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    runGit(['rev-parse', 'HEAD'], { cwd }),
    runGit(['rev-parse', '--short', 'HEAD'], { cwd }),
    runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd }),
    runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd, allowFailure: true }),
  ]);

  const dirtyEntries = parseGitStatusPorcelain(statusResult.stdout);
  const autoStashEligible = canAutoStashDirtyEntries(dirtyEntries);
  const upstream = upstreamResult.error ? '' : upstreamResult.stdout;
  let checkError = '';

  if (refresh && upstream) {
    const fetchResult = await runGit(['fetch', '--prune'], { cwd, allowFailure: true });
    if (fetchResult.error) {
      checkError = fetchResult.stderr || fetchResult.stdout || fetchResult.error?.message || 'git fetch failed';
    }
  }

  let aheadCount = 0;
  let behindCount = 0;
  let remoteCommit = null;
  let remoteCommitShort = null;

  if (upstream) {
    const aheadBehindResult = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { cwd, allowFailure: true });
    if (aheadBehindResult.error) {
      checkError = checkError || aheadBehindResult.stderr || aheadBehindResult.stdout || aheadBehindResult.error?.message || 'Unable to compare with upstream.';
    } else {
      const counts = parseAheadBehind(aheadBehindResult.stdout);
      aheadCount = counts.aheadCount;
      behindCount = counts.behindCount;
    }

    const [remoteCommitResult, remoteCommitShortResult] = await Promise.all([
      runGit(['rev-parse', upstream], { cwd, allowFailure: true }),
      runGit(['rev-parse', '--short', upstream], { cwd, allowFailure: true }),
    ]);

    if (!remoteCommitResult.error) {
      remoteCommit = remoteCommitResult.stdout || null;
    }
    if (!remoteCommitShortResult.error) {
      remoteCommitShort = remoteCommitShortResult.stdout || null;
    }
  }

  const updateInProgress = updateInProgressOverride == null
    ? Boolean(activeUpdatePromise)
    : Boolean(updateInProgressOverride);

  const blockedReason = buildBlockedReason({
    dirtyEntries,
    hasUpstream: Boolean(upstream),
    aheadCount,
    behindCount,
    updateInProgress,
  });

  const updateAvailable = behindCount > 0;
  const canUpdate = updateAvailable && !blockedReason;

  let statusMessage = '';
  if (blockedReason) {
    statusMessage = blockedReason;
  } else if (updateAvailable) {
    statusMessage = appendDirtyStatus(
      `Update available: ${behindCount} ${pluralize(behindCount, 'commit')} behind ${upstream}.`,
      dirtyEntries,
      { autoStashEligible },
    );
  } else if (aheadCount > 0) {
    statusMessage = appendDirtyStatus(
      `Local branch is ${aheadCount} ${pluralize(aheadCount, 'commit')} ahead of ${upstream}.`,
      dirtyEntries,
      { autoStashEligible },
    );
  } else if (upstream) {
    statusMessage = appendDirtyStatus(
      `App is up to date with ${upstream}.`,
      dirtyEntries,
      { autoStashEligible },
    );
  } else {
    statusMessage = appendDirtyStatus(
      'Upstream branch information is unavailable.',
      dirtyEntries,
      { autoStashEligible },
    );
  }

  return {
    currentVersion: version,
    branch: branchResult.stdout || 'HEAD',
    upstream: upstream || null,
    currentCommit: currentCommitResult.stdout || null,
    currentCommitShort: currentCommitShortResult.stdout || null,
    remoteCommit,
    remoteCommitShort,
    dirty: dirtyEntries.length > 0,
    dirtyEntries,
    autoStashEligible,
    aheadCount,
    behindCount,
    updateAvailable,
    canUpdate,
    updateInProgress,
    blockedReason,
    statusMessage,
    checkError: checkError || null,
    checkedAt: new Date().toISOString(),
  };
}

export async function getAppUpdateStatus({ cwd = process.cwd(), refresh = false } = {}) {
  return collectRepoStatus(cwd, { refresh });
}

export async function applyAppUpdate({ cwd = process.cwd() } = {}) {
  if (activeUpdatePromise) {
    throw new AppUpdateError('Another update is already running.', 423, 'update_in_progress');
  }

  const updateTask = (async () => {
    const statusBefore = await collectRepoStatus(cwd, {
      refresh: true,
      updateInProgressOverride: false,
    });

    if (statusBefore.blockedReason) {
      throw new AppUpdateError(statusBefore.blockedReason, 409, 'update_blocked');
    }

    let stashContext = null;
    let restoreResult = {
      attempted: false,
      restored: false,
      conflicted: false,
      stashRef: null,
      detail: '',
      cleanupSucceeded: false,
      cleanupDetail: '',
    };

    try {
      if (statusBefore.autoStashEligible) {
        stashContext = await stashLocalChanges(cwd, statusBefore.dirtyEntries);
      }

      if (!statusBefore.updateAvailable) {
        restoreResult = await restoreStashedChanges(cwd, stashContext);
        if (restoreResult.conflicted && !restoreResult.cleanupSucceeded) {
          throw new AppUpdateError(
            restoreResult.stashRef
              ? `App is already up to date, but local changes could not be restored cleanly. Resolve them manually from ${restoreResult.stashRef}.`
              : 'App is already up to date, but local changes could not be restored cleanly.',
            409,
            'update_restore_conflict',
          );
        }

        const finalStatus = await collectRepoStatus(cwd, {
          refresh: false,
          updateInProgressOverride: false,
        });

        return {
          updated: false,
          installRan: false,
          installMode: null,
          restartRequired: false,
          reloadRecommended: false,
          changedFiles: [],
          localChangesStashed: Boolean(stashContext),
          localChangesRestored: restoreResult.restored,
          localChangesRequireManualRestore: restoreResult.conflicted,
          stashRef: restoreResult.stashRef,
          previousVersion: statusBefore.currentVersion,
          currentVersion: statusBefore.currentVersion,
          previousCommit: statusBefore.currentCommit,
          previousCommitShort: statusBefore.currentCommitShort,
          currentCommit: statusBefore.currentCommit,
          currentCommitShort: statusBefore.currentCommitShort,
          summary: buildUpdateSummary({
            updated: false,
            installRan: false,
            installMode: null,
            restartRequired: false,
            reloadRecommended: false,
            previousCommitShort: statusBefore.currentCommitShort,
            currentCommitShort: statusBefore.currentCommitShort,
            localChangesStashed: Boolean(stashContext),
            localChangesRestored: restoreResult.restored,
            localChangesRequireManualRestore: restoreResult.conflicted,
            stashRef: restoreResult.stashRef,
          }),
          status: finalStatus,
        };
      }

      await runGit(['pull', '--ff-only'], { cwd });

      const [afterCommitResult, afterCommitShortResult] = await Promise.all([
        runGit(['rev-parse', 'HEAD'], { cwd }),
        runGit(['rev-parse', '--short', 'HEAD'], { cwd }),
      ]);

      const afterCommit = afterCommitResult.stdout || statusBefore.currentCommit;
      const afterCommitShort = afterCommitShortResult.stdout || statusBefore.currentCommitShort;

      const changedFilesResult = afterCommit && statusBefore.currentCommit && afterCommit !== statusBefore.currentCommit
        ? await runGit(['diff', '--name-only', `${statusBefore.currentCommit}..${afterCommit}`], { cwd })
        : { stdout: '' };

      const changedFiles = String(changedFilesResult.stdout || '')
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean);

      const installRan = await needsDependencyInstallForUpdate({
        cwd,
        changedFiles,
        previousCommit: statusBefore.currentCommit,
        currentCommit: afterCommit,
      });
      let installMode = null;
      if (installRan) {
        const installPlan = await getDependencyInstallArgs(cwd);
        installMode = installPlan.installMode;
        await runNpm(installPlan.args, { cwd });

        const manifestDrift = await getManifestDrift(cwd);
        if (manifestDrift.length > 0) {
          const dirtySummary = summarizePaths(manifestDrift).join(', ');
          throw new AppUpdateError(
            `Dependency refresh modified tracked manifests unexpectedly: ${dirtySummary}. Align Node/npm versions, then rerun the update.`,
            500,
            'dependency_manifest_drift',
          );
        }
      }

      const currentVersion = await readPackageVersion(cwd);
      const restartRequired = installRan || needsAppRestart(changedFiles);
      const reloadRecommended = !restartRequired && needsPageReload(changedFiles);
      const updated = afterCommit !== statusBefore.currentCommit;

      restoreResult = await restoreStashedChanges(cwd, stashContext);
      if (restoreResult.conflicted && !restoreResult.cleanupSucceeded) {
        throw new AppUpdateError(
          restoreResult.stashRef
            ? `The app updated, but the working tree could not be cleaned after restoring local changes. Resolve them manually from ${restoreResult.stashRef}.`
            : 'The app updated, but the working tree could not be cleaned after restoring local changes.',
          409,
          'update_restore_conflict',
        );
      }

      const statusAfter = await collectRepoStatus(cwd, {
        refresh: false,
        updateInProgressOverride: false,
      });

      return {
        updated,
        installRan,
        installMode,
        restartRequired,
        reloadRecommended,
        changedFiles,
        localChangesStashed: Boolean(stashContext),
        localChangesRestored: restoreResult.restored,
        localChangesRequireManualRestore: restoreResult.conflicted,
        stashRef: restoreResult.stashRef,
        previousVersion: statusBefore.currentVersion,
        currentVersion,
        previousCommit: statusBefore.currentCommit,
        previousCommitShort: statusBefore.currentCommitShort,
        currentCommit: afterCommit,
        currentCommitShort: afterCommitShort,
        summary: buildUpdateSummary({
          updated,
          installRan,
          installMode,
          restartRequired,
          reloadRecommended,
          previousCommitShort: statusBefore.currentCommitShort,
          currentCommitShort: afterCommitShort,
          localChangesStashed: Boolean(stashContext),
          localChangesRestored: restoreResult.restored,
          localChangesRequireManualRestore: restoreResult.conflicted,
          stashRef: restoreResult.stashRef,
        }),
        status: statusAfter,
      };
    } catch (error) {
      if (stashContext && !restoreResult.attempted) {
        restoreResult = await restoreStashedChanges(cwd, stashContext);
      }

      if (restoreResult.conflicted) {
        const message = error?.message || 'Failed to apply app update.';
        const cleanupNote = restoreResult.cleanupSucceeded
          ? ' The working tree was reset to the updated commit.'
          : restoreResult.cleanupDetail
            ? ` Cleanup also failed: ${restoreResult.cleanupDetail}`
            : '';
        throw new AppUpdateError(
          restoreResult.stashRef
            ? `${message} Local changes were preserved in ${restoreResult.stashRef} and need manual restoration.${cleanupNote}`
            : `${message} Local changes could not be restored cleanly.${cleanupNote}`,
          error instanceof AppUpdateError ? error.status : 500,
          'update_restore_conflict',
        );
      }

      throw error;
    }
  })();

  activeUpdatePromise = updateTask.finally(() => {
    activeUpdatePromise = null;
  });

  return activeUpdatePromise;
}
