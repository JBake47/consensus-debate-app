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
      path: line.slice(3).trim(),
    }));
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

export function canAutoStashDirtyEntries(entries = []) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  return normalizedEntries.length > 0 && !normalizedEntries.some(isUnmergedGitStatus);
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

async function restoreStashedChanges(cwd, stashContext) {
  if (!stashContext?.ref) {
    return {
      attempted: false,
      restored: false,
      conflicted: false,
      stashRef: null,
      detail: '',
    };
  }

  const popResult = await runGit(['stash', 'pop', stashContext.ref], { cwd, allowFailure: true });
  if (!popResult.error) {
    return {
      attempted: true,
      restored: true,
      conflicted: false,
      stashRef: null,
      detail: popResult.stdout || popResult.stderr || '',
    };
  }

  const stashStillExists = await stashRefExists(cwd, stashContext.ref);
  return {
    attempted: true,
    restored: false,
    conflicted: true,
    stashRef: stashStillExists ? stashContext.ref : null,
    detail: popResult.stderr || popResult.stdout || popResult.error?.message || 'git stash pop failed',
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
    };

    try {
      if (statusBefore.autoStashEligible) {
        stashContext = await stashLocalChanges(cwd, statusBefore.dirtyEntries);
      }

      if (!statusBefore.updateAvailable) {
        restoreResult = await restoreStashedChanges(cwd, stashContext);
        if (restoreResult.conflicted) {
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

      const installRan = needsDependencyInstall(changedFiles);
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
        throw new AppUpdateError(
          restoreResult.stashRef
            ? `${message} Local changes were preserved in ${restoreResult.stashRef} and need manual restoration.`
            : `${message} Local changes could not be restored cleanly.`,
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
