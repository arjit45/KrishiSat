'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Historical hindcast / replay — PRD §10.2 F11, §11.6, §24, §28.8.
//
// Replays the SHIPPED core over NASA POWER daily precipitation, season-year by
// season-year, and records the resulting tier and payout. Build-time only: the
// server reads the committed snapshot (backend/config/hindcast.json) and computes
// nothing on a request path (§9.4).
//
// Two disclosures this file exists to keep honest, both required by the PRD's
// labelling rules rather than optional courtesies:
//
//   1. Different reanalysis source than the live view. The live dashboard uses
//      Open-Meteo; the hindcast uses NASA POWER. §28.8: "the same methodology over
//      a different reanalysis source ... a methodology sanity check, NOT a
//      validation against real claim outcomes."
//   2. The soil leg is absent. NASA POWER daily carries precipitation only, so
//      there is no soil-moisture series to test the §12.3 second leg against. The
//      replay therefore marks every season `durationMode: 'estimated'`, which
//      disables the duration OR-clauses (§10.1 F3) and decides tiers on WSI alone.
//      That makes the measured trigger frequency a WSI-band frequency — a real
//      measurement, but a conservative one, and never presented as more.
//
// Because the soil value is assumed (θ = field capacity), it changes no tier: with
// the OR-clauses disabled the tier is a function of WSI, which is precipitation and
// stage only. It is recorded as `assumed` so nobody later mistakes it for data.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { DISTRICTS, DISTRICT_IDS } = require('../config/districts');
const climateCache = require('../engines/climateCache');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'config', 'hindcast.json');

/** §10.2 F11: 10–20 years. 20 season-years is the top of that range. */
const DEFAULT_START_YEAR = 2006;
const DEFAULT_END_YEAR = 2025;

const DAY_MS = 86_400_000;

const SEASONS = Object.freeze(['kharif', 'rabi']);

// ── Calendar ───────────────────────────────────────────────────────────────
function iso(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eachDay(fromStr, toStr) {
  const out = [];
  for (let t = Date.parse(`${fromStr}T00:00:00Z`); t <= Date.parse(`${toStr}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The window a season-year covers.
 *   kharif Y = 1 Jun Y  → 30 Nov Y   (the §12.2 Jun–Nov calendar)
 *   rabi   Y = 1 Dec Y−1 → 31 May Y  (the season that ENDS in year Y)
 * Recorded here because the Rabi season-year spans the new year, and an
 * off-by-one would silently shift every Rabi measurement by a year.
 */
function seasonWindow(season, year) {
  if (season === 'kharif') return { from: iso(year, 6, 1), to: iso(year, 11, 30) };
  return { from: iso(year - 1, 12, 1), to: iso(year, 5, 31) };
}

// ── Replay ─────────────────────────────────────────────────────────────────
const RANK = ['BELOW_THRESHOLD', 'PREVENTED_SOWING', 'TIER_1_MODERATE', 'TIER_2_SEVERE', 'TIER_3_CATASTROPHIC'];
const rankOf = (tier) => RANK.indexOf(tier);

/** Per-season frequency and peak distribution, so the two seasons stay separable. */
function seasonStats(records) {
  const round1 = (v) => Math.round(v * 10) / 10;
  const out = {};
  for (const season of SEASONS) {
    const rs = records.filter((r) => r.season === season);
    const peaks = rs.map((r) => r.peakWsi).sort((a, b) => a - b);
    const triggered = rs.filter((r) => r.tier !== 'BELOW_THRESHOLD').length;
    out[season] = {
      seasonsEvaluated: rs.length,
      triggerFrequency: rs.length ? round1((triggered / rs.length) * 100) : null,
      peakWsiStats: peaks.length ? {
        min: peaks[0], median: peaks[Math.floor(peaks.length / 2)], max: peaks[peaks.length - 1],
      } : null,
    };
  }
  return out;
}

/**
 * Replay one district's season-year. Pure: everything it needs is passed in.
 *
 * @param {object} core the loaded core module (§14.2)
 * @param {object} args
 * @param {object} args.district registry entry (§11.1)
 * @param {string} args.season 'kharif' | 'rabi'
 * @param {number} args.year
 * @param {Map<string, number|null>} args.precipByDate daily PRECTOTCORR, null = gap
 * @param {number[]} args.monthlyMm committed baseline, January first
 * @returns {object|null} the §11.6 record, or null when the window is unusable
 */
function replaySeason(core, { district, season, year, precipByDate, monthlyMm }) {
  const { from, to } = seasonWindow(season, year);
  const dates = eachDay(from, to);
  const seasonNumber = core.ksSeasonNumber(season);

  let best = null;
  let evaluated = 0;
  let skipped = 0;

  for (const date of dates) {
    // A trailing 30-day window is the index driver, so a gap inside it makes that
    // date unevaluable. Skipping is the §27 "backtest data gap → skip the affected
    // window, report coverage" rule; substituting a zero would fabricate drought.
    const window = [];
    let complete = true;
    for (let i = 29; i >= 0; i--) {
      const d = addDays(date, -i);
      const v = precipByDate.get(d);
      if (v === undefined || v === null) { complete = false; break; }
      window.push(v);
    }
    if (!complete) { skipped += 1; continue; }

    const month = Number(date.slice(5, 7));
    const stage = core.ksStageInfo(month, seasonNumber);
    const prevMonth = month === 1 ? 12 : month - 1;

    const input = {
      districtId: district.id,
      season,
      date,
      scenarioId: null,
      baselineMonthlyMm: monthlyMm[month - 1],
      baselinePrevMonthMm: monthlyMm[prevMonth - 1],
      expected30Mm: core.ksExpected30Mm(date, monthlyMm[month - 1], monthlyMm[prevMonth - 1]),
      actual30Mm: window.reduce((a, b) => a + b, 0),
      // ASSUMED, not measured: see the header. It changes no tier here because the
      // duration OR-clauses are disabled below.
      currentSoilMoisture: district.fieldCapacity,
      currentSoilMoistureSource: 'assumed_field_capacity',
      historicalSoilMoistureSource: 'unavailable_in_hindcast_source',
      fieldCapacity: district.fieldCapacity,
      wiltingPoint: district.wiltingPoint,
      cropStageId: stage.stageId,
      cropStageMultiplier: stage.multiplier,
      // NASA POWER daily has no soil series, so the §12.3 second leg cannot be
      // tested. Estimated duration is the only truthful setting (§12.3, F11).
      droughtWeeks: 0,
      durationIsEstimated: true,
    };

    const out = core.ksCompute(input);
    evaluated += 1;
    if (!best || rankOf(out.payoutTier) > rankOf(best.tier)
      || (rankOf(out.payoutTier) === rankOf(best.tier) && out.weightedShortfallIndex > best.peakWsi)) {
      best = {
        districtId: district.id,
        year,
        season,
        peakWsi: Math.round(out.weightedShortfallIndex * 100) / 100,
        tier: out.payoutTier,
        payoutPerHectare: out.payoutPerHectare,
        // §11.6 fields end here; the rest are disclosures added by F11's labelling
        // rules: the OR-clauses were off, and the soil leg is absent.
        peakDate: date,
        durationWeeks: 0,
        durationMode: 'estimated',
        severityLevel: out.severityLevel,
        soilLeg: 'unavailable_in_hindcast_source',
        rainfallShortfallPercentage: Math.round(out.rainfallShortfallPercentage * 100) / 100,
      };
    }
  }

  if (!best) return null;
  best.evaluatedDays = evaluated;
  best.skippedDays = skipped;
  return best;
}

/**
 * Replay every district and return the §11.6 summary shape expected by
 * `/api/backtest/:district`.
 *
 * @param {object} core loaded core module
 * @param {{startYear?:number, endYear?:number, dailyByDistrict: Map<string, Map<string, number|null>>, generatedAt?:string}} args
 */
function runHindcast(core, { startYear = DEFAULT_START_YEAR, endYear = DEFAULT_END_YEAR, dailyByDistrict, generatedAt }) {
  const out = {};
  for (const id of DISTRICT_IDS) {
    const district = DISTRICTS[id];
    const precipByDate = dailyByDistrict.get(id);
    if (!precipByDate) throw new Error(`no daily series for ${id}`);
    const { monthlyMm } = climateCache.getMonthlyBaselines(id);

    const records = [];
    for (let year = startYear; year <= endYear; year++) {
      for (const season of SEASONS) {
        const record = replaySeason(core, { district, season, year, precipByDate, monthlyMm });
        if (record) records.push(record);
      }
    }

    const triggered = records.filter((r) => r.tier !== 'BELOW_THRESHOLD');
    const tierCounts = {};
    for (const tier of RANK) tierCounts[tier] = records.filter((r) => r.tier === tier).length;

    const round1 = (v) => Math.round(v * 10) / 10;
    const freq = records.length ? round1((triggered.length / records.length) * 100) : null;

    // The distribution matters as much as the headline number: a 100% frequency
    // with peaks just over the threshold and one with peaks at 100 are the same
    // figure and very different findings. Recorded so the number is checkable.
    const peaks = records.map((r) => r.peakWsi).sort((a, b) => a - b);
    const at = (q) => (peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(q * peaks.length))] : null);

    // Frequency of reaching each tier or higher, which is what a season actually costs.
    const atLeast = {};
    for (let i = 1; i < RANK.length; i++) {
      const tier = RANK[i];
      atLeast[tier] = records.length
        ? round1((records.filter((r) => rankOf(r.tier) >= i).length / records.length) * 100)
        : null;
    }

    out[id] = {
      districtId: id,
      years: endYear - startYear + 1,
      seasonsEvaluated: records.length,
      // §11.6: seasons that triggered / total seasons.
      triggerFrequency: freq,
      tierCounts,
      // §24's band rule: first-hindcast frequency ±15 pp, clamped to 0–100.
      triggerBand: freq === null ? null : [Math.max(0, round1(freq - 15)), Math.min(100, round1(freq + 15))],
      peakWsiStats: peaks.length ? {
        min: peaks[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: peaks[peaks.length - 1],
      } : null,
      triggerFrequencyAtLeastTier: atLeast,
      // Split by season, because the two seasons are not comparable: Rabi runs
      // through months whose climatological expectation is a few millimetres, so a
      // percentage shortfall there is large for a trivial absolute deficit (§F1
      // uses a ratio, and a ratio against ~3 mm is a different quantity from a
      // ratio against ~160 mm). A single blended number would hide that.
      bySeason: seasonStats(records),
      cumulativePayoutPerHectare: records.reduce((a, r) => a + r.payoutPerHectare, 0),
      records,
    };
  }

  return {
    source: 'NASA POWER daily PRECTOTCORR (community AG, time-standard=UTC)',
    parameter: 'PRECTOTCORR',
    period: `${startYear}-${endYear}`,
    generatedAt: generatedAt || new Date().toISOString(),
    methodology: {
      core: 'backend/core/ks_core.mjs — the shipped core, unchanged (§14.2)',
      liveViewSource: 'Open-Meteo (forecast + ERA5-Land archive)',
      hindcastSource: 'NASA POWER daily reanalysis — a DIFFERENT source, same methodology (§28.8)',
      durationMode: 'estimated for every season-year: NASA POWER daily carries no soil series, so the §12.3 soil leg cannot be tested and the OR-clauses are disabled',
      soilAssumption: 'θ = field capacity, labelled assumed; it changes no tier because tiers are WSI-decided in this mode',
      windowDefinition: 'kharif Y = 1 Jun – 30 Nov Y · rabi Y = 1 Dec Y−1 – 31 May Y',
      gapRule: 'a scan date whose trailing 30-day window contains a gap is skipped, and the count is reported (§27)',
      triggerFrequencyDefinition: 'A season-year "triggers" when its PEAK season-day reaches any tier (§11.6). With a 30-day index, that asks whether the season was EVER dry enough — not whether it was dry on the day a decision was taken.',
      readingTheFrequency: 'Because the peak is taken over ~183 season-days and the WSI bands start at 25, a high frequency is arithmetically expected: any single 30-day dry spell weighted by a 1.5–2.0 growing-stage multiplier can cross Tier 1. A frequency near 100% is therefore a statement about the season PEAK, and must not be quoted as a per-decision probability. §24 gates on this number as defined, so the definition is recorded beside it rather than left to a reader to infer.',
      openFinding: 'Measured 2006–2025: every district peaks above a tier in every season-year. Whether that is a calibration defect in the §12.2 multipliers, an over-broad WSI band, or simply what the locked rules say about season peaks is an OPEN QUESTION recorded in §12.6 — it is not resolved here, and nothing in this snapshot changes a threshold.',
      disclaimer: 'A methodology sanity check, NOT a validation against real claim outcomes (§28.8).',
    },
    districts: out,
  };
}

/** Read the committed snapshot. Never throws — the caller reports unavailability. */
function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** One district's summary from the snapshot, or null when absent (§18.6). */
function getSummary(districtId) {
  const snapshot = readSnapshot();
  if (!snapshot || !snapshot.districts) return null;
  return snapshot.districts[districtId] || null;
}

function isAvailable() {
  const snapshot = readSnapshot();
  return Boolean(snapshot && snapshot.districts);
}

module.exports = {
  runHindcast,
  replaySeason,
  readSnapshot,
  getSummary,
  isAvailable,
  seasonWindow,
  eachDay,
  addDays,
  SNAPSHOT_PATH,
  DEFAULT_START_YEAR,
  DEFAULT_END_YEAR,
};
