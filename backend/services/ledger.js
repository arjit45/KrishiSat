'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// F7 simulated settlement ledger (§10.2 F7, §11.5).
//
// Causal: entries exist ONLY for districts currently meeting a payout trigger, and
// each entry's tier and amount are that district's computed tier and amount.
// Member source: every entry is drawn from the F12 roster (§config/members.js),
// which is the sole authority for member identity, name and area. This module
// applies no selection rule of its own — it does not pick, sample or shuffle.
//
// Deterministic: for a given day, scenario and set of triggers the ledger is
// byte-identical across reloads. There is no Math.random() and no dependence on the
// wall clock — the only clock input is the calendar DATE (which the computation
// itself depends on), never the time of day. Timestamps are anchored to a fixed
// daily settlement time plus a fixed per-entry offset, so a reload at 10:00 and at
// 15:00 produce identical strings.
//
// The ledger is OUTPUT, never input: no requirement may read it to decide a payout
// (§14.5, §F15), and it is labelled as a simulation wherever it is displayed (§19.2).
// ─────────────────────────────────────────────────────────────────────────────

const { getMembers } = require('../config/members');

/** Fixed daily settlement time: 06:00 IST. Entries are offsets from it. */
const SETTLEMENT_HOUR_IST = 6;
const SETTLEMENT_MINUTE_IST = 0;

/** Fixed per-entry offset, so ordering is stable and the clock is never consulted. */
const ENTRY_OFFSET_MINUTES = 35;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Format an epoch as `YYYY-MM-DD HH:MM IST`. Never locale-dependent:
 * `toLocaleTimeString` output varies with the ICU build, which would break the
 * byte-identical-across-machines requirement (§F7).
 *
 * The date is included because the fixed offsets can carry a long roster past
 * midnight; a clock-only string would then sort as if it had gone backwards. With
 * the date the entries stay lexicographically ordered for any roster size.
 */
function formatIstTimestamp(epochMs) {
  const shifted = new Date(epochMs + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d} ${hh}:${mm} IST`;
}

/**
 * Epoch of the fixed settlement instant on a calendar date. 06:00 IST is 00:30 UTC
 * on the same date; the offset arithmetic is written out so changing the settlement
 * time cannot silently shift the day.
 * @param {string} dateStr `YYYY-MM-DD`
 * @returns {number|null} null when the date is unusable
 */
function settlementEpoch(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const base = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return null;
  const utcMinutes = SETTLEMENT_HOUR_IST * 60 + SETTLEMENT_MINUTE_IST - 330; // IST → UTC
  const dayShift = Math.floor(utcMinutes / 1440);
  const withinDay = utcMinutes - dayShift * 1440;
  return base + dayShift * 86400000 + withinDay * 60000;
}

/** Timestamp for entry `index`, anchored to the settlement instant. */
function entryTimestamp(settlementMs, index) {
  if (settlementMs === null) return null;
  return formatIstTimestamp(settlementMs + index * ENTRY_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Build the ledger from already-computed district weather results.
 *
 * Pure and synchronous by design: it takes the results rather than fetching them, so
 * the route owns caching and the tests own the inputs (§22.1). A district with no
 * trigger, no engine output, or a degraded computation contributes no entries — it
 * is skipped, never given a substituted or invented amount.
 *
 * @param {Array<any>} results — deficitEngine results, in registry order
 * @param {{scenario?: {id:string,label:string}|null}} [options]
 * @returns {Array<{memberRef:string,cooperative:string,tier:string,amount:number,
 *   triggerIndex:string,cropStage:string,hectares:number,timestamp:string}>}
 */
function buildLedger(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return [];

  // The settlement date is the computed season date, so a reload on the same day
  // settles on the same day regardless of when it is opened.
  const settlementMs = settlementEpoch(list[0].seasonDate);
  const entries = [];

  for (const result of list) {
    const engine = result && result.engineOutput;
    if (!engine || engine.isTriggerMet !== true) continue;
    if (engine.payoutPerHectare === null || engine.payoutPerHectare === undefined) continue;

    const members = getMembers(result.district && result.district.id);
    if (members.length === 0) continue;

    const cropStage = (result.cropStage && result.cropStage.label) || 'Unknown';
    const triggerIndex = `WSI: ${engine.weightedShortfallIndex.toFixed(1)}%`;

    for (const member of members) {
      // whole rupees: the seed areas are 0.1 ha and payouts are exact rupees, so
      // rounding here is a display decision, not a loss of information.
      const amount = Math.round(member.hectares * engine.payoutPerHectare);
      entries.push({
        memberRef: `${member.name} (${member.memberRef})`,
        cooperative: member.cooperative,
        tier: engine.payoutTier,
        amount,
        triggerIndex,
        cropStage,
        hectares: member.hectares,
        timestamp: entryTimestamp(settlementMs, entries.length),
      });
    }
  }

  return entries;
}

module.exports = {
  buildLedger,
  // exported for tests and for the F14 scenario path, which needs the same anchor
  settlementEpoch,
  entryTimestamp,
  formatIstTimestamp,
  ENTRY_OFFSET_MINUTES,
  SETTLEMENT_HOUR_IST,
};
