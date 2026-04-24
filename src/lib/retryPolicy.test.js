import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_POLICY,
  normalizeRetryPolicy,
  isNonRetryableError,
  isTransientRetryableError,
  shouldAffectCircuitBreaker,
  getRetryDelayMs,
  getRetryDelayMsForError,
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

runTest('isTransientRetryableError detects upstream rate-limited text without status', () => {
  assert.equal(
    isTransientRetryableError({
      message: 'deepseek/deepseek-v4-flash is temporarily rate-limited upstream. Please retry shortly.',
    }, () => false),
    true,
  );
});

runTest('isTransientRetryableError detects provider 429 code behind 400 status', () => {
  const error = {
    status: 400,
    code: 429,
    message: 'Provider returned error',
  };
  assert.equal(isNonRetryableError(error), false);
  assert.equal(isTransientRetryableError(error, () => false), true);
});

runTest('shouldAffectCircuitBreaker ignores invalid attachment parse errors', () => {
  assert.equal(
    shouldAffectCircuitBreaker({ status: 400, message: 'Failed to parse scanned.pdf' }, () => false),
    false,
  );
  assert.equal(
    shouldAffectCircuitBreaker({ status: 503, message: 'temporarily unavailable' }, () => false),
    true,
  );
});

runTest('shouldAffectCircuitBreaker ignores status-less provider PDF parse errors', () => {
  const err = new Error('{"error":{"message":"Failed to parse Mom, Dad & Sister.pdf","code":400}}');
  assert.equal(shouldAffectCircuitBreaker(err, () => false), false);
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

runTest('getRetryDelayMsForError uses longer backoff for rate limits', () => {
  const delay = getRetryDelayMsForError(1, DEFAULT_RETRY_POLICY, { status: 429 }, () => 0);
  const normalDelay = getRetryDelayMsForError(1, DEFAULT_RETRY_POLICY, { status: 503 }, () => 0);
  assert.ok(delay >= 7500);
  assert.ok(delay > normalDelay);
});

// eslint-disable-next-line no-console
console.log('Retry policy tests completed.');
