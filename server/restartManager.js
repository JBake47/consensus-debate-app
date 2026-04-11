import { spawn as spawnProcess } from 'node:child_process';

const RESTART_ARGS_ENV_KEY = 'CONSENSUS_RESTART_ARGS';
const RESTART_EXEC_ARGV_ENV_KEY = 'CONSENSUS_RESTART_EXEC_ARGV';
const RESTART_CWD_ENV_KEY = 'CONSENSUS_RESTART_CWD';
const RESTART_DELAY_ENV_KEY = 'CONSENSUS_RESTART_DELAY_MS';
const DEFAULT_RESTART_DELAY_MS = 1500;

export class AppRestartError extends Error {
  constructor(message, status = 500, code = 'restart_failed') {
    super(message);
    this.name = 'AppRestartError';
    this.status = status;
    this.code = code;
  }
}

export function getSelfRestartArgs({ argv = process.argv } = {}) {
  const restartArgs = Array.isArray(argv)
    ? argv.slice(1).filter((value) => String(value || '').trim())
    : [];

  if (restartArgs.length === 0) {
    throw new AppRestartError(
      'Automatic restart is unavailable because this process has no restartable entrypoint.',
      503,
      'restart_unavailable',
    );
  }

  return restartArgs;
}

export function buildRestartHelperScript() {
  return [
    "const { spawn } = require('node:child_process');",
    `const restartExecArgv = JSON.parse(process.env.${RESTART_EXEC_ARGV_ENV_KEY} || '[]');`,
    `const restartArgs = JSON.parse(process.env.${RESTART_ARGS_ENV_KEY} || '[]');`,
    `const restartCwd = process.env.${RESTART_CWD_ENV_KEY} || process.cwd();`,
    `const restartDelayMs = Math.max(0, Number(process.env.${RESTART_DELAY_ENV_KEY} || '0'));`,
    "if (!Array.isArray(restartExecArgv) || !Array.isArray(restartArgs) || restartArgs.length === 0) { process.exit(1); }",
    'const nextEnv = { ...process.env };',
    `delete nextEnv.${RESTART_EXEC_ARGV_ENV_KEY};`,
    `delete nextEnv.${RESTART_ARGS_ENV_KEY};`,
    `delete nextEnv.${RESTART_CWD_ENV_KEY};`,
    `delete nextEnv.${RESTART_DELAY_ENV_KEY};`,
    'const timer = setTimeout(() => {',
    "  const child = spawn(process.execPath, [...restartExecArgv, ...restartArgs], { cwd: restartCwd, env: nextEnv, detached: true, stdio: 'ignore', windowsHide: true });",
    "  child.unref();",
    '}, restartDelayMs);',
    "if (typeof timer.unref === 'function') timer.unref();",
  ].join('\n');
}

export function scheduleSelfRestart({
  execPath = process.execPath,
  execArgv = process.execArgv,
  argv = process.argv,
  cwd = process.cwd(),
  env = process.env,
  delayMs = DEFAULT_RESTART_DELAY_MS,
  spawnImpl = spawnProcess,
} = {}) {
  const restartArgs = getSelfRestartArgs({ argv });
  const restartExecArgv = Array.isArray(execArgv)
    ? execArgv.filter((value) => String(value || '').trim())
    : [];
  const normalizedDelayMs = Number.isFinite(delayMs)
    ? Math.max(0, Math.round(delayMs))
    : DEFAULT_RESTART_DELAY_MS;

  try {
    const helper = spawnImpl(execPath, ['-e', buildRestartHelperScript()], {
      cwd,
      env: {
        ...env,
        [RESTART_EXEC_ARGV_ENV_KEY]: JSON.stringify(restartExecArgv),
        [RESTART_ARGS_ENV_KEY]: JSON.stringify(restartArgs),
        [RESTART_CWD_ENV_KEY]: cwd,
        [RESTART_DELAY_ENV_KEY]: String(normalizedDelayMs),
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    helper.unref?.();
    return {
      scheduled: true,
      delayMs: normalizedDelayMs,
    };
  } catch (error) {
    throw new AppRestartError(
      error?.message || 'Failed to schedule automatic restart.',
      500,
      'restart_schedule_failed',
    );
  }
}
