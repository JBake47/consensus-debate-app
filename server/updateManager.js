import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const GIT_COMMAND = process.platform === 'win32' ? 'git.exe' : 'git';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 1024 * 1024;

const INSTALL_TRIGGER_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
]);

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

function buildBlockedReason({ dirtyEntries, hasUpstream, aheadCount, behindCount, updateInProgress }) {
  if (updateInProgress) {
    return 'Another update is already running.';
  }

  if (dirtyEntries.length > 0) {
    const dirtySummary = summarizePaths(dirtyEntries).join(', ');
    return `Update blocked because the working tree has uncommitted changes: ${dirtySummary}`;
  }

  if (!hasUpstream) {
    return 'Update blocked because this branch has no upstream tracking branch.';
  }

  if (aheadCount > 0 && behindCount > 0) {
    return 'Update blocked because the local branch has diverged from upstream. Reconcile it manually first.';
  }

  return null;
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
  restartRequired,
  reloadRecommended,
  previousCommitShort,
  currentCommitShort,
}) {
  if (!updated) {
    return 'App is already up to date.';
  }

  const messages = [
    `Updated ${previousCommitShort || 'current commit'} to ${currentCommitShort || 'latest commit'}.`,
  ];

  if (installRan) {
    messages.push('Dependencies were refreshed.');
  }

  if (restartRequired) {
    messages.push('Restart the app to load backend or dependency changes.');
  } else if (reloadRecommended) {
    messages.push('Refresh the page if the UI does not reload automatically.');
  } else {
    messages.push('No restart should be required.');
  }

  return messages.join(' ');
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
    statusMessage = `Update available: ${behindCount} ${pluralize(behindCount, 'commit')} behind ${upstream}.`;
  } else if (aheadCount > 0) {
    statusMessage = `Local branch is ${aheadCount} ${pluralize(aheadCount, 'commit')} ahead of ${upstream}.`;
  } else if (upstream) {
    statusMessage = `App is up to date with ${upstream}.`;
  } else {
    statusMessage = 'Upstream branch information is unavailable.';
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

    if (!statusBefore.updateAvailable) {
      return {
        updated: false,
        installRan: false,
        restartRequired: false,
        reloadRecommended: false,
        changedFiles: [],
        previousVersion: statusBefore.currentVersion,
        currentVersion: statusBefore.currentVersion,
        previousCommit: statusBefore.currentCommit,
        previousCommitShort: statusBefore.currentCommitShort,
        currentCommit: statusBefore.currentCommit,
        currentCommitShort: statusBefore.currentCommitShort,
        summary: 'App is already up to date.',
        status: statusBefore,
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
    if (installRan) {
      await runNpm(['install', '--no-audit', '--no-fund'], { cwd });
    }

    const currentVersion = await readPackageVersion(cwd);
    const restartRequired = installRan || needsAppRestart(changedFiles);
    const reloadRecommended = !restartRequired && needsPageReload(changedFiles);
    const updated = afterCommit !== statusBefore.currentCommit;
    const summary = buildUpdateSummary({
      updated,
      installRan,
      restartRequired,
      reloadRecommended,
      previousCommitShort: statusBefore.currentCommitShort,
      currentCommitShort: afterCommitShort,
    });

    const statusAfter = await collectRepoStatus(cwd, {
      refresh: false,
      updateInProgressOverride: false,
    });

    return {
      updated,
      installRan,
      restartRequired,
      reloadRecommended,
      changedFiles,
      previousVersion: statusBefore.currentVersion,
      currentVersion,
      previousCommit: statusBefore.currentCommit,
      previousCommitShort: statusBefore.currentCommitShort,
      currentCommit: afterCommit,
      currentCommitShort: afterCommitShort,
      summary,
      status: statusAfter,
    };
  })();

  activeUpdatePromise = updateTask.finally(() => {
    activeUpdatePromise = null;
  });

  return activeUpdatePromise;
}
