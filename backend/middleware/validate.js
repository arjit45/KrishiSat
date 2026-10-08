'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Input validation — PRD §15.2.
//
// `:district` is validated against the fixed registry (allowlist). The value is
// never interpolated into an outbound URL; outbound coordinates come from the
// registry only, which is what makes SSRF structurally impossible here rather
// than merely discouraged.
//
// Every failure returns a GENERIC message (§15.9): a client learns that a field
// is invalid, not how the server is built.
// ─────────────────────────────────────────────────────────────────────────────

const { getDistrict } = require('../config/districts');

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 404 when the district is not a registry key (§15.2). */
function requireDistrict(req, res, next) {
  const key = req.params.district;
  const district = getDistrict(key);
  if (!district) return res.status(404).json({ error: 'District not found.' });
  req.district = district;
  return next();
}

/** `?season=` must be exactly kharif or rabi when present (§15.2, §10.1 F2). */
function readSeason(req) {
  const raw = req.query.season;
  if (raw === undefined || raw === '') return { ok: true, season: undefined, source: 'auto' };
  if (raw !== 'kharif' && raw !== 'rabi') return { ok: false, error: 'Invalid season.' };
  return { ok: true, season: raw, source: 'user' };
}

/** Optional `?from=`/`?to=` ISO dates, inclusive, `from ≤ to` (§18.9). */
function readDateRange(req) {
  const { from, to } = req.query;
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value !== undefined && value !== '' && !ISO_RE.test(String(value))) {
      return { ok: false, error: `Invalid ${name}.` };
    }
  }
  if (from && to && String(from) > String(to)) {
    return { ok: false, error: 'Invalid range: from must not be after to.' };
  }
  return { ok: true, from: from || undefined, to: to || undefined };
}

/** `limit` defaults to 50 and is CLAMPED to 200, never rejected (§18.9). */
function readLimit(req, { def = 50, max = 200 } = {}) {
  const raw = req.query.limit;
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * POST /api/calculate-payout body (§18.3, §15.2).
 * Bounds are enforced here; the tier decision itself is the core's (§14.2).
 *
 * @param {any} body
 * @param {Set<string>} validStageIds — derived from the core, never a second copy
 */
function validatePayoutBody(body, validStageIds) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid body.' };
  }

  const wsi = body.weightedShortfallIndex;
  if (typeof wsi !== 'number' || !Number.isFinite(wsi) || wsi < 0 || wsi > 100) {
    return { ok: false, error: 'Invalid weightedShortfallIndex.' };
  }

  const weeks = body.droughtWeeks;
  if (typeof weeks !== 'number' || !Number.isFinite(weeks) || weeks < 0 || weeks > 8) {
    return { ok: false, error: 'Invalid droughtWeeks.' };
  }

  if (typeof body.durationIsEstimated !== 'boolean') {
    return { ok: false, error: 'Invalid durationIsEstimated.' };
  }

  const cropStage = body.cropStage;
  if (typeof cropStage !== 'string' || !validStageIds.has(cropStage)) {
    return { ok: false, error: 'Invalid cropStage.' };
  }

  if (body.season !== 'kharif' && body.season !== 'rabi') {
    return { ok: false, error: 'Invalid season.' };
  }

  return {
    ok: true,
    value: {
      weightedShortfallIndex: wsi,
      droughtWeeks: weeks,
      durationIsEstimated: body.durationIsEstimated,
      cropStage,
      season: body.season,
    },
  };
}

module.exports = {
  requireDistrict,
  readSeason,
  readDateRange,
  readLimit,
  validatePayoutBody,
  ISO_RE,
};
