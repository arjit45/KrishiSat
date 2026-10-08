'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting — PRD §15.5.
//
// Counters live in process memory, so on a serverless runtime they are PER
// INSTANCE and reset whenever the platform recycles one. §15.5 is explicit that
// this makes a limiter a speed bump, not a guarantee: the authoritative
// protections are the upstream quotas (§23.2) and the fact that no request path
// fans out unboundedly. This file therefore deliberately does not pretend to be a
// global limiter, and no correctness property depends on it.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000;

// Requests per IP per minute. The weather/districts routes fan out to two external
// APIs each, so they are throttled harder than the pure-computation route (§15.5).
const LIMITS = Object.freeze({
  expensive: 60,
  normal: 120,
  payout: 120,
});

/** @type {Map<string, {count:number, resetAt:number}>} */
const buckets = new Map();
let lastSweep = 0;

function clientIp(req) {
  const fwd = req.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function sweep(now) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * @param {'expensive'|'normal'|'payout'} kind
 */
function rateLimit(kind) {
  const max = LIMITS[kind] || LIMITS.normal;
  return function limiter(req, res, next) {
    const now = Date.now();
    sweep(now);
    const key = `${kind}:${clientIp(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + WINDOW_MS };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

/** Test hook: forget every counter. */
function resetBuckets() {
  buckets.clear();
  lastSweep = 0;
}

module.exports = { rateLimit, resetBuckets, LIMITS, WINDOW_MS };
