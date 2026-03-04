import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_POLICY,
  normalizeRetryPolicy,
  isNonRetryableError,
  isTransientRetryableError,
  getRetryDelayMs,
} from './retryPolicy.js';

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

runTest('normalizeRetryPolicy clamps unsafe values', () => {
  const policy = normalizeRetryPolicy({
    maxAttempts: 100,
    baseDelayMs: -20,
    maxDelayMs: 50,
    circuitFailureThreshold: 0,
    circuitCooldownMs: 1,
  });

  assert.equal(policy.maxAttempts, 6);
  assert.equal(policy.baseDelayMs, 100);
  assert.equal(policy.maxDelayMs, 100);
  assert.equal(policy.circuitFailureThreshold, 1);
  assert.equal(policy.circuitCooldownMs, 5000);
});

runTest('isNonRetryableError detects auth and invalid request errors', () => {
  assert.equal(isNonRetryableError({ status: 401 }), true);
  assert.equal(isNonRetryableError({ code: 'invalid_request' }), true);
  assert.equal(isNonRetryableError({ message: 'unsupported provider' }), true);
  assert.equal(isNonRetryableError({ status: 503 }), false);
});

runTest('isTransientRetryableError detects 429 and timeout unless aborted', () => {
  assert.equal(
    isTransientRetryableError({ status: 429 }, () => false),
    true,
  );
  assert.equal(
    isTransientRetryableError({ message: 'network timeout while reading stream' }, () => false),
    true,
  );
  assert.equal(
    isTransientRetryableError({ status: 503 }, () => true),
    false,
  );
});

runTest('getRetryDelayMs applies jitter and bounds', () => {
  const minJitter = () => 0;
  const maxJitter = () => 1;
  const low = getRetryDelayMs(1, DEFAULT_RETRY_POLICY, minJitter);
  const high = getRetryDelayMs(6, DEFAULT_RETRY_POLICY, maxJitter);

  assert.ok(low >= DEFAULT_RETRY_POLICY.baseDelayMs);
  assert.ok(high <= DEFAULT_RETRY_POLICY.maxDelayMs);
  assert.ok(high >= low);
});

// eslint-disable-next-line no-console
console.log('Retry policy tests completed.');
