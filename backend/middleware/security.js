'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Transport, headers & CORS origin allowlist — PRD §15.3, §15.4.
//
// The CSP must permit (a) the core module served from this same origin (F10 would
// silently die without it) and (b) the OpenStreetMap tile origin the map needs
// (§13.4). It deliberately does NOT permit arbitrary scripts.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DEV_ORIGINS = Object.freeze([
  'http://localhost:5173', 'http://127.0.0.1:5173',   // vite dev
  'http://localhost:4173', 'http://127.0.0.1:4173',   // vite preview
  'http://localhost:3000', 'http://127.0.0.1:3000',
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.tile.openstreetmap.org https://tile.openstreetmap.org",
  "connect-src 'self' https://api.open-meteo.com https://archive-api.open-meteo.com https://power.larc.nasa.gov",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Security headers. Applied to every response (§15.4). */
function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    // Production is served over HTTPS behind the platform's proxy (§15.4).
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * CORS with an allowlist (§15.3). Three allowed cases, nothing else:
 *   1. no Origin header — a non-browser caller (curl, a server, the cron job);
 *   2. the Origin matches this deployment's own Host — production is ONE origin
 *      (§21.2), so the browser's calls to /api/* are same-origin there;
 *   3. the Origin is listed in CORS_ORIGINS (or, when that is unset, a local dev
 *      origin — so local development works without configuration).
 *
 * An unlisted origin is rejected with 403, not merely left without CORS headers:
 * §15.3 says such requests are rejected.
 */
function corsAllowlist(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();

  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = configured.length ? configured : DEFAULT_DEV_ORIGINS;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  if (allow.includes(origin) || originHost === req.headers.host) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  return res.status(403).json({ error: 'Forbidden origin' });
}

module.exports = { securityHeaders, corsAllowlist, CSP, DEFAULT_DEV_ORIGINS };
