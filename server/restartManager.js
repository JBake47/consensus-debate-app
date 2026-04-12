import { spawn as spawnProcess } from 'node:child_process';
import path from 'node:path';

const RESTART_ARGS_ENV_KEY = 'CONSENSUS_RESTART_ARGS';
const RESTART_EXEC_ARGV_ENV_KEY = 'CONSENSUS_RESTART_EXEC_ARGV';
const RESTART_CWD_ENV_KEY = 'CONSENSUS_RESTART_CWD';
const RESTART_DELAY_ENV_KEY = 'CONSENSUS_RESTART_DELAY_MS';
const RESTART_PREVIOUS_STARTED_AT_ENV_KEY = 'CONSENSUS_RESTART_PREVIOUS_STARTED_AT';
const RESTART_LOG_PATH_ENV_KEY = 'CONSENSUS_RESTART_LOG_PATH';
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
    "const { appendFileSync } = require('node:fs');",
    `const restartLogPath = String(process.env.${RESTART_LOG_PATH_ENV_KEY} || '').trim() || null;`,
    'const log = (message) => {',
    '  if (!restartLogPath) return;',
    "  try { appendFileSync(restartLogPath, `${new Date().toISOString()} ${message}\\n`); } catch {}",
    '};',
    'const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });',
    `const restartExecArgv = JSON.parse(process.env.${RESTART_EXEC_ARGV_ENV_KEY} || '[]');`,
    `const restartArgs = JSON.parse(process.env.${RESTART_ARGS_ENV_KEY} || '[]');`,
    `const restartCwd = process.env.${RESTART_CWD_ENV_KEY} || process.cwd();`,
    `const restartDelayMs = Math.max(0, Number(process.env.${RESTART_DELAY_ENV_KEY} || '0'));`,
    `const previousStartedAt = String(process.env.${RESTART_PREVIOUS_STARTED_AT_ENV_KEY} || '').trim() || null;`,
    "const configuredHost = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';",
    "const configuredPortRaw = Number.parseInt(String(process.env.PORT || '3001'), 10);",
    "const configuredPort = Number.isFinite(configuredPortRaw) && configuredPortRaw > 0 ? configuredPortRaw : 3001;",
    "if (!Array.isArray(restartExecArgv) || !Array.isArray(restartArgs) || restartArgs.length === 0) { log('restart helper aborted because restart metadata was missing'); process.exit(1); }",
    'const nextEnv = { ...process.env };',
    `delete nextEnv.${RESTART_EXEC_ARGV_ENV_KEY};`,
    `delete nextEnv.${RESTART_ARGS_ENV_KEY};`,
    `delete nextEnv.${RESTART_CWD_ENV_KEY};`,
    `delete nextEnv.${RESTART_DELAY_ENV_KEY};`,
    `delete nextEnv.${RESTART_PREVIOUS_STARTED_AT_ENV_KEY};`,
    `delete nextEnv.${RESTART_LOG_PATH_ENV_KEY};`,
    'const normalizeProbeHost = (value) => {',
    "  const normalized = String(value || '').trim();",
    "  if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {",
    "    return '127.0.0.1';",
    '  }',
    '  return normalized;',
    '};',
    'const buildHealthUrl = () => {',
    '  const probeHost = normalizeProbeHost(configuredHost);',
    "  const hostLabel = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;",
    "  return `http://${hostLabel}:${configuredPort}/api/health?_ts=${Date.now()}`;",
    '};',
    'const readHealth = async () => {',
    '  try {',
    "    const response = await fetch(buildHealthUrl(), { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });",
    '    if (!response.ok) return null;',
    '    return await response.json();',
    '  } catch {',
    '    return null;',
    '  }',
    '};',
    'const waitForPreviousServerToStop = async (deadlineMs) => {',
    '  while (Date.now() < deadlineMs) {',
    '    const health = await readHealth();',
    '    if (!health) {',
    "      return { stopped: true, alreadyRestarted: false };",
    '    }',
    '    if (!previousStartedAt || health.startedAt !== previousStartedAt) {',
    "      return { stopped: true, alreadyRestarted: true };",
    '    }',
    '    await sleep(300);',
    '  }',
    "  return { stopped: false, alreadyRestarted: false };",
    '};',
    'const waitForReplacementServer = async (child, deadlineMs) => {',
    '  let exited = false;',
    '  let exitCode = null;',
    '  let exitSignal = null;',
    '  child.once(\'exit\', (code, signal) => {',
    '    exited = true;',
    '    exitCode = code;',
    '    exitSignal = signal;',
    '  });',
    "  child.once('error', () => {",
    '    exited = true;',
    "    exitCode = 'spawn_error';",
    '  });',
    '  while (Date.now() < deadlineMs) {',
    '    const health = await readHealth();',
    '    if (health && (!previousStartedAt || health.startedAt !== previousStartedAt)) {',
    "      return { healthy: true, exited, exitCode, exitSignal };",
    '    }',
    '    if (exited) {',
    "      return { healthy: false, exited, exitCode, exitSignal };",
    '    }',
    '    await sleep(400);',
    '  }',
    "  return { healthy: false, exited, exitCode, exitSignal };",
    '};',
    '(async () => {',
    "  log(`restart helper launched for ${restartArgs.join(' ')}`);",
    '  if (restartDelayMs > 0) {',
    '    await sleep(restartDelayMs);',
    '  }',
    '  const overallDeadlineMs = Date.now() + 45_000;',
    '  while (Date.now() < overallDeadlineMs) {',
    '    const stopStatus = await waitForPreviousServerToStop(Math.min(overallDeadlineMs, Date.now() + 5_000));',
    '    if (stopStatus.alreadyRestarted) {',
    "      log('replacement server was already healthy before a restart attempt was needed');",
    '      process.exit(0);',
    '    }',
    '    if (!stopStatus.stopped) {',
    '      await sleep(500);',
    '      continue;',
    '    }',
    "    log('previous server stopped responding; attempting replacement startup');",
    "    const child = spawn(process.execPath, [...restartExecArgv, ...restartArgs], { cwd: restartCwd, env: nextEnv, detached: true, stdio: 'ignore', windowsHide: true });",
    "    child.unref();",
    '    const result = await waitForReplacementServer(child, Math.min(overallDeadlineMs, Date.now() + 15_000));',
    '    if (result.healthy) {',
    "      log('replacement server reported healthy; restart completed');",
    '      process.exit(0);',
    '    }',
    "    const exitLabel = result.exited ? ` exited (${result.exitCode ?? 'unknown'}${result.exitSignal ? `, ${result.exitSignal}` : ''})` : ' did not report healthy before timeout';",
    "    log(`restart attempt failed; child${exitLabel}`);",
    '    await sleep(1_000);',
    '  }',
    "  log('restart helper timed out waiting for the replacement server to become healthy');",
    '  process.exit(1);',
    '})().catch((error) => {',
    "  log(`restart helper crashed: ${error && error.stack ? error.stack : error}`);",
    '  process.exit(1);',
    '});',
  ].join('\n');
}

export function scheduleSelfRestart({
  execPath = process.execPath,
  execArgv = process.execArgv,
  argv = process.argv,
  cwd = process.cwd(),
  env = process.env,
  delayMs = DEFAULT_RESTART_DELAY_MS,
  previousStartedAt = null,
  logPath = path.join(cwd, 'server', '.restart.log'),
  spawnImpl = spawnProcess,
} = {}) {
  const restartArgs = getSelfRestartArgs({ argv });
  const restartExecArgv = Array.isArray(execArgv)
    ? execArgv.filter((value) => String(value || '').trim())
    : [];
  const normalizedPreviousStartedAt = String(previousStartedAt || '').trim() || '';
  const normalizedLogPath = String(logPath || '').trim() || '';
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
        [RESTART_PREVIOUS_STARTED_AT_ENV_KEY]: normalizedPreviousStartedAt,
        [RESTART_LOG_PATH_ENV_KEY]: normalizedLogPath,
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
