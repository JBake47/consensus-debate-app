import assert from 'node:assert/strict';
import {
  AppRestartError,
  getSelfRestartArgs,
  scheduleSelfRestart,
} from './restartManager.js';

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

runTest('getSelfRestartArgs preserves the current entrypoint and arguments', () => {
  assert.deepEqual(
    getSelfRestartArgs({
      argv: ['C:\\Program Files\\nodejs\\node.exe', 'server/index.js', '--port', '3001'],
    }),
    ['server/index.js', '--port', '3001'],
  );
});

runTest('getSelfRestartArgs fails when no restartable entrypoint is available', () => {
  assert.throws(
    () => getSelfRestartArgs({ argv: ['C:\\Program Files\\nodejs\\node.exe'] }),
    (error) => error instanceof AppRestartError && error.code === 'restart_unavailable',
  );
});

runTest('scheduleSelfRestart spawns a detached helper with restart metadata', () => {
  const calls = [];
  let unrefCalled = false;

  const result = scheduleSelfRestart({
    execPath: 'node.exe',
    execArgv: ['--inspect=0', '--trace-warnings'],
    argv: ['node.exe', 'server/index.js', '--inspect=0'],
    cwd: 'C:\\repo',
    env: { FOO: 'bar' },
    delayMs: 900,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return {
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  assert.equal(result.scheduled, true);
  assert.equal(result.delayMs, 900);
  assert.equal(unrefCalled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'node.exe');
  assert.deepEqual(calls[0].args.slice(0, 1), ['-e']);
  assert.equal(calls[0].options.cwd, 'C:\\repo');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.FOO, 'bar');
  assert.equal(
    calls[0].options.env.CONSENSUS_RESTART_EXEC_ARGV,
    JSON.stringify(['--inspect=0', '--trace-warnings']),
  );
  assert.equal(
    calls[0].options.env.CONSENSUS_RESTART_ARGS,
    JSON.stringify(['server/index.js', '--inspect=0']),
  );
  assert.equal(calls[0].options.env.CONSENSUS_RESTART_CWD, 'C:\\repo');
  assert.equal(calls[0].options.env.CONSENSUS_RESTART_DELAY_MS, '900');
});

// eslint-disable-next-line no-console
console.log('Restart manager tests completed.');
