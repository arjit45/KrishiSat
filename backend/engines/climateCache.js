'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Climate cache — PRD §12.4, §12.5.
//
// The 30-year climatology is static, so it is fetched once at build time and
// committed as backend/config/climate-baseline.json with a fetchedAt timestamp and
// its source. The server seeds this cache from that file, so the FIRST request
// never waits on NASA POWER and never has to serve a reduced-fidelity fallback
// (§12.4 "Cold start is designed out").
//
// The file is read lazily and cached for the process lifetime; on a serverless
// runtime the process may be recycled between any two requests, so the cache is a
// latency optimisation only. Its absence is never observable in a response: a
// cold instance simply re-reads the file, which is a few milliseconds.
//
// Only if the snapshot file itself is missing or lacks a district does the §12.5
// emergency path apply, and then the value is marked FALLBACK everywhere it is used.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { DISTRICTS, DISTRICT_IDS, getDistrict } = require('../config/districts');
const { DAYS_IN_MONTH_NON_LEAP } = require('../services/nasaPower');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'config', 'climate-baseline.json');
const MONTHS_PER_YEAR = 12;

let snapshotCache; // undefined = not read yet, null = unreadable, object = loaded

/** Read (once) and validate the committed snapshot. Never throws (§12.4). */
function readSnapshot() {
  if (snapshotCache !== undefined) return snapshotCache;
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.districts) {
      snapshotCache = null;
      return snapshotCache;
    }
    snapshotCache = parsed;
  } catch (err) {
    // A missing or corrupt snapshot is an operational problem, not a request
    // failure: §12.5 fallback values keep the product usable (§16.2).
    // eslint-disable-next-line no-console
    console.warn(`[climateCache] snapshot unavailable (${err.message}); using §12.5 fallback values`);
    snapshotCache = null;
  }
  return snapshotCache;
}

/** Test/hook: drop the process-lifetime cache (§12.4). */
function resetCache() {
  snapshotCache = undefined;
}

/**
 * The §12.5 monthly shape, derived from a district's monsoon/annual totals:
 * the monsoon share `m = monsoon ÷ annual` is split equally across Jun–Sep and
 * the remaining `1 − m` equally across the other eight months. Recorded in §12.5
 * as the implemented shape and tagged `[WORKING]` — it is superseded entirely by
 * the committed snapshot whenever that file has the district.
 *
 * @param {{fallbackMm:{monsoon:number,annual:number}}} district
 * @returns {number[]} 12 monthly totals, January first
 */
function fallbackMonthlyMm(district) {
  const { monsoon, annual } = district.fallbackMm;
  const m = monsoon / annual;
  const monsoonMonth = (annual * m) / 4;          // Jun, Jul, Aug, Sep
  const otherMonth = (annual * (1 - m)) / 8;      // the other eight months
  return DAYS_IN_MONTH_NON_LEAP.map((_, i) => {
    const month = i + 1;
    const v = month >= 6 && month <= 9 ? monsoonMonth : otherMonth;
    return Math.round(v * 100) / 100;
  });
}

/**
 * Monthly baselines for one district, with provenance.
 *
 * @param {string} districtId
 * @returns {{monthlyMm:number[], source:'snapshot'|'fallback',
 *   sourceLabel:string, period:string|null, fetchedAt:string|null}}
 */
function getMonthlyBaselines(districtId) {
  const district = getDistrict(districtId);
  if (!district) throw new RangeError(`unknown district "${districtId}"`);

  const snapshot = readSnapshot();
  const entry = snapshot && snapshot.districts ? snapshot.districts[districtId] : null;
  const monthly = entry && Array.isArray(entry.monthlyMm) ? entry.monthlyMm : null;

  if (monthly && monthly.length === MONTHS_PER_YEAR && monthly.every((v) => Number.isFinite(v) && v >= 0)) {
    // The snapshot's own coordinates are recorded, so a grid-cell change between
    // refreshes is visible rather than silent (§13.3).
    return {
      monthlyMm: monthly.slice(),
      source: 'snapshot',
      sourceLabel: `${snapshot.source || 'NASA POWER climatology'} ${snapshot.period || ''}`.trim(),
      period: snapshot.period || null,
      fetchedAt: snapshot.fetchedAt || null,
    };
  }

  return {
    monthlyMm: fallbackMonthlyMm(district),
    source: 'fallback',
    sourceLabel: '§12.5 emergency fallback values (IMD long-term averages, [WORKING])',
    period: null,
    fetchedAt: null,
  };
}

/**
 * The two baselines the canonical engine input publishes (§11.2): the current
 * month's and the previous month's, so a third party can reconstruct
 * `expected30Mm` from first principles for a window that straddles two months.
 *
 * @param {string} districtId
 * @param {string} dateStr ISO yyyy-mm-dd — the season-day
 */
function getMonthBaselines(districtId, dateStr) {
  const month = Number(String(dateStr).slice(5, 7));
  if (!(month >= 1 && month <= 12)) throw new TypeError('date must be ISO yyyy-mm-dd');
  const prev = month === 1 ? 12 : month - 1;
  const { monthlyMm, ...provenance } = getMonthlyBaselines(districtId);
  return {
    // Both are MONTH NUMBERS 1..12; the array is 0-based, hence the −1 on each.
    baselineMonthlyMm: monthlyMm[month - 1],
    baselinePrevMonthMm: monthlyMm[prev - 1],
    monthlyMm,
    ...provenance,
  };
}

/** True when the snapshot has every registry district — used by /api/health. */
function isSeeded() {
  const snapshot = readSnapshot();
  return Boolean(snapshot && DISTRICT_IDS.every((id) => snapshot.districts[id]));
}

module.exports = {
  getMonthlyBaselines,
  getMonthBaselines,
  fallbackMonthlyMm,
  isSeeded,
  resetCache,
  readSnapshot,
  SNAPSHOT_PATH,
  DISTRICTS,
};
