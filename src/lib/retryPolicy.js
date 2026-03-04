function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Math.floor(toNumber(value, fallback));
  return Math.max(min, Math.min(max, parsed));
}

export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 700,
  maxDelayMs: 5000,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 90 * 1000,
};

export function normalizeRetryPolicy(raw = {}) {
  const maxAttempts = clampInteger(
    raw.maxAttempts,
    1,
    6,
    DEFAULT_RETRY_POLICY.maxAttempts,
  );
  const baseDelayMs = clampInteger(
    raw.baseDelayMs,
    100,
    10_000,
    DEFAULT_RETRY_POLICY.baseDelayMs,
  );
  const maxDelayMs = clampInteger(
    raw.maxDelayMs,
    baseDelayMs,
    30_000,
    DEFAULT_RETRY_POLICY.maxDelayMs,
  );
  const circuitFailureThreshold = clampInteger(
    raw.circuitFailureThreshold,
    1,
    10,
    DEFAULT_RETRY_POLICY.circuitFailureThreshold,
  );
  const circuitCooldownMs = clampInteger(
    raw.circuitCooldownMs,
    5_000,
    10 * 60 * 1000,
    DEFAULT_RETRY_POLICY.circuitCooldownMs,
  );
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    circuitFailureThreshold,
    circuitCooldownMs,
  };
}

export function parseRetryableStatus(err) {
  const status = Number(err?.status);
  return Number.isFinite(status) ? status : null;
}

export function isNonRetryableError(err) {
  const status = parseRetryableStatus(err);
  if ([400, 401, 402, 403, 404, 422].includes(status)) return true;
  const code = String(err?.code || '').toLowerCase();
  if (
    code.includes('invalid_key') ||
    code.includes('invalid_request') ||
    code.includes('insufficient_credits') ||
    code.includes('model_not_found') ||
    code.includes('unsupported')
  ) {
    return true;
  }
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('unauthorized') ||
    message.includes('insufficient credits') ||
    message.includes('invalid model') ||
    message.includes('unsupported provider') ||
    message.includes('bad request') ||
    message.includes('malformed')
  );
}

export function isTransientRetryableError(err, isAbortLikeError = () => false) {
  if (!err || isAbortLikeError(err) || isNonRetryableError(err)) return false;
  const status = parseRetryableStatus(err);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(err?.code || '').toLowerCase();
  if (code.includes('rate_limit') || code.includes('stream_stalled') || code.includes('timeout')) return true;
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('temporarily unavailable') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('connection reset') ||
    message.includes('econnreset') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('504')
  );
}

export function getRetryDelayMs(attemptNumber, policy, random = Math.random) {
  const normalized = normalizeRetryPolicy(policy);
  const exp = normalized.baseDelayMs * (2 ** Math.max(0, attemptNumber - 1));
  const jitter = 0.75 + random() * 0.5;
  return Math.round(
    Math.max(
      normalized.baseDelayMs,
      Math.min(normalized.maxDelayMs, exp * jitter),
    ),
  );
}
