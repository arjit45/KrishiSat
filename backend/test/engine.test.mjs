// ─────────────────────────────────────────────────────────────────────────────
// Engine + integration tests — PRD §22.1 layers 1, 5 and 7.
//
// The externals are MOCKED through the engine's `deps` seam, so these tests are
// hermetic: no network, no clock dependence, no quota use. What they pin down is
// the part the core cannot cover by itself — the trailing-window assembly, the
// §12.3 duration decision (including the archive-lag case that is the NORM, not an
// edge case), the §11.8 quality derivation, and the §12.4/§12.5 baseline paths.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const engine = require('../engines/deficitEngine');
const climateCache = require('../engines/climateCache');
const { getDistrict, DISTRICT_IDS } = require('../config/districts');

const { ksCompute, ksExpected30Mm, ksMonthToDateExpectedMm, ksCwsi, THRESHOLDS, TIER } = await import('../core/ks_core.mjs');

const DAY = 86_400_000;
const TODAY = '2026-10-08';          // fixed: the engine takes the date it is given
const DATES = Array.from({ length: 57 }, (_, i) => addDays(TODAY, i - 56));

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A synthetic LIVE forecast payload: dry (or wet) trailing window. */
function forecastStub({ precipMm = 0.5, soil = 0.15, days = 57 } = {}) {
  return {
    daily: DATES.slice(-days).map((date) => ({ date, precipMm })),
    currentSoilMoisture: soil,
    currentSoilMoistureTime: `${TODAY}T18:30`,
    currentPrecipMm: precipMm,
    hourlySoil: DATES.slice(-days).flatMap((date) =>
      Array.from({ length: 24 }, (_, h) => ({
        time: `${date}T${String(h).padStart(2, '0')}:00`, value: soil,
      }))),
  };
}

/** A synthetic archive payload; `missing` dates are returned as null (§13.1). */
function archiveStub({ soil = 0.15, missing = [] } = {}) {
  const gone = new Set(missing);
  return {
    daily: DATES.map((date) => ({ date, soilMoisture: gone.has(date) ? null : soil })),
    hoursPerDay: 24,
  };
}

const LIVE_DEPS = {
  fetchForecast: async () => forecastStub(),
  fetchArchiveSoil: async () => archiveStub(),
};

// ── Layer 7 — LIVE path, end to end, no network ─────────────────────────────
describe('§22.1 layer 7 — LIVE path through mocked externals', () => {
  test('assembles the canonical input and computes a real, reproducible receipt', async () => {
    const r = await engine.computeDistrictWeather('jalna', { date: TODAY, season: 'kharif', deps: LIVE_DEPS });
    assert.equal(r.degraded, false);
    assert.equal(r.dataQuality, 'LIVE');
    assert.deepEqual(r.sources, { openMeteoForecast: 'LIVE', openMeteoArchive: 'LIVE', nasaPower: 'LIVE' });

    // §11.2 — every field of the canonical input is present
    const keys = Object.keys(r.engineInput).sort();
    assert.deepEqual(keys, [
      'actual30Mm', 'baselineMonthlyMm', 'baselinePrevMonthMm', 'cropStageId',
      'cropStageMultiplier', 'currentSoilMoisture', 'currentSoilMoistureSource', 'date',
      'districtId', 'droughtWeeks', 'durationIsEstimated', 'expected30Mm', 'fieldCapacity',
      'historicalSoilMoistureSource', 'scenarioId', 'season', 'wiltingPoint',
    ]);
    assert.equal(r.engineInput.districtId, 'jalna');
    assert.equal(r.engineInput.scenarioId, null);
    assert.equal(r.engineInput.currentSoilMoistureSource, 'forecast_model');
    assert.equal(r.engineInput.historicalSoilMoistureSource, 'era5_land_reanalysis');

    // The engine does not compute the index: the shipped core does, on this input.
    assert.deepEqual(r.engineOutput, ksCompute(r.engineInput));

    // §10.2 F10 — the receipt recomputes from the PUBLISHED canonical string with an
    // independent hash, which is exactly what the browser verification view does.
    const independent = createHash('sha256').update(r.receipt.canonicalInput, 'utf8').digest('hex');
    assert.equal(independent, r.receipt.receiptId);
    assert.equal(r.receipt.canonicalEncoding, 'scaled-int-v1');
  });

  test('expected30Mm matches the core for the same two baselines (§11.2)', async () => {
    const r = await engine.computeDistrictWeather('jalna', { date: TODAY, season: 'kharif', deps: LIVE_DEPS });
    const fromCore = ksExpected30Mm(
      TODAY, r.baselineProvenance.baselineMonthlyMm, r.baselineProvenance.baselinePrevMonthMm,
    );
    assert.equal(r.expected30Mm, Math.round(fromCore * 1000) / 1000);
    assert.notEqual(r.baselineProvenance.baselineMonthlyMm, r.baselineProvenance.baselinePrevMonthMm);
    assert.equal(
      r.monthToDateExpectedMm,
      Math.round(ksMonthToDateExpectedMm(TODAY, r.baselineProvenance.baselineMonthlyMm) * 1000) / 1000,
    );
  });

  test('actual30Mm is the sum of exactly the trailing 30 days', async () => {
    const r = await engine.computeDistrictWeather('dewas', { date: TODAY, season: 'kharif', deps: LIVE_DEPS });
    assert.equal(r.actual30Mm, 15);  // 30 days × 0.5 mm
    assert.equal(r.monthToDateMm, 4); // 8 days of October × 0.5 mm
  });

  test('a scenario id is carried into the canonical input, so receipts cannot collide (F14)', async () => {
    const live = await engine.computeDistrictWeather('jalna', { date: TODAY, deps: LIVE_DEPS });
    const replay = await engine.computeDistrictWeather('jalna', {
      date: TODAY, scenarioId: 'jalna-2016', deps: LIVE_DEPS,
    });
    assert.equal(replay.engineInput.scenarioId, 'jalna-2016');
    assert.notEqual(live.receipt.receiptId, replay.receipt.receiptId);
    // …and everything else about the computation is unchanged
    assert.equal(live.engineOutput.payoutTier, replay.engineOutput.payoutTier);
  });

  test('JSON-serialising the engine input cannot change the digest (§10.2 F10)', async () => {
    const r = await engine.computeDistrictWeather('bikaner', { date: TODAY, deps: LIVE_DEPS });
    assert.equal(ksCompute(JSON.parse(JSON.stringify(r.engineInput))).weightedShortfallIndex,
      r.engineOutput.weightedShortfallIndex);
    const again = await engine.computeDistrictWeather('bikaner', { date: TODAY, deps: LIVE_DEPS });
    assert.equal(again.receipt.receiptId, r.receipt.receiptId);
  });
});

// ── Layer 7 — degradation ladder (§23.3) ────────────────────────────────────
describe('§23.3 degradation ladder', () => {
  test('archive down → PARTIAL, duration estimated, OR-clauses disabled', async () => {
    const r = await engine.computeDistrictWeather('jalna', {
      date: TODAY, season: 'kharif',
      deps: { fetchForecast: async () => forecastStub(), fetchArchiveSoil: async () => { throw new Error('archive 503'); } },
    });
    assert.equal(r.dataQuality, 'PARTIAL');
    assert.equal(r.sources.openMeteoArchive, 'FALLBACK');
    assert.equal(r.engineOutput.durationIsEstimated, true);
    assert.equal(r.fallbackReasons.length, 1);
    assert.match(r.fallbackReasons[0], /archive/);

    // §12.3 fallback duration = min(8, floor(WSI / 12)), and the tier is WSI-only
    const expectedWeeks = Math.min(8, Math.floor(r.engineOutput.weightedShortfallIndex / 12));
    assert.equal(r.engineOutput.droughtDurationWeeks, expectedWeeks);
    assert.equal(
      r.engineOutput.payoutTier,
      ksCompute({ ...r.engineInput, droughtWeeks: 0, durationIsEstimated: true }).payoutTier,
    );
  });

  test('forecast down → no shortfall is fabricated (§16.2, §23.3)', async () => {
    const r = await engine.computeDistrictWeather('jalna', {
      date: TODAY, season: 'kharif',
      deps: { fetchForecast: async () => { throw new Error('forecast timeout'); }, fetchArchiveSoil: async () => archiveStub() },
    });
    assert.equal(r.degraded, true);
    assert.equal(r.dataQuality, 'PARTIAL');       // nasaPower snapshot is still LIVE
    assert.equal(r.engineInput, null);
    assert.equal(r.engineOutput, null);
    assert.equal(r.receipt, null);
    assert.equal(r.actual30Mm, null);             // NOT 0 — no data is not no rain
    assert.equal(r.soilMoistureRaw, null);
    assert.deepEqual(r.cwsiTrend, []);
    assert.equal(r.expected30Mm > 0, true);       // the committed baseline still exists
  });

  test('both Open-Meteo sources down → PARTIAL, because the baseline is still real data', async () => {
    const fail = async () => { throw new Error('down'); };
    const r = await engine.computeDistrictWeather('dewas', { date: TODAY, deps: { fetchForecast: fail, fetchArchiveSoil: fail } });
    assert.equal(r.dataQuality, 'PARTIAL');
    assert.equal(r.sources.nasaPower, 'LIVE');    // the committed snapshot never fails
    assert.equal(r.degraded, true);
    assert.match(r.fallbackReasons.join(' '), /forecast/);
    assert.match(r.fallbackReasons.join(' '), /archive/);
  });

  test('the unrecoverable state — no snapshot and no live call — is OFFLINE', async () => {
    const fs = require('fs');
    const real = climateCache.SNAPSHOT_PATH;
    const backup = `${real}.test-bak`;
    fs.renameSync(real, backup);
    climateCache.resetCache();
    try {
      const fail = async () => { throw new Error('down'); };
      const r = await engine.computeDistrictWeather('dewas', { date: TODAY, deps: { fetchForecast: fail, fetchArchiveSoil: fail } });
      assert.equal(r.dataQuality, 'OFFLINE');
      assert.equal(r.sources.nasaPower, 'FALLBACK');
      assert.equal(r.degraded, true);
      // §12.5 values are still applied (§16.2: the dashboard renders), and named.
      assert.equal(r.baselineProvenance.source, 'fallback');
      assert.match(r.baselineProvenance.sourceLabel, /§12\.5/);
      assert.equal(r.expected30Mm > 0, true);
    } finally {
      fs.renameSync(backup, real);
      climateCache.resetCache();
    }
  });

  test('archive lag on the most recent days → estimated duration, coverage reported', async () => {
    // The NORMAL case (§13.1): ERA5-Land updates daily with a ~5-day delay.
    const recent = DATES.slice(-3);
    const r = await engine.computeDistrictWeather('jalna', {
      date: TODAY, season: 'kharif',
      deps: {
        fetchForecast: async () => forecastStub(),
        fetchArchiveSoil: async () => archiveStub({ missing: recent }),
      },
    });
    assert.equal(r.engineOutput.durationIsEstimated, true);
    assert.equal(r.durationCoverage.soilDaysPresent, 53);
    assert.equal(r.durationCoverage.windowDays, 56);
    assert.equal(r.durationCoverage.lastSoilDate, addDays(TODAY, -3));
    assert.match(r.durationReason, /not fully covered/);
    assert.equal(r.dataQuality, 'LIVE'); // the archive answered; it is simply lagging
    assert.equal(r.sources.openMeteoArchive, 'LIVE');
  });

  test('a baseline snapshot that is missing is reported, never silently applied', async () => {
    // The §12.5 path is covered directly in the climate-cache suite below; here we
    // only assert that whatever path is used is NAMED in the response.
    const r = await engine.computeDistrictWeather('jalna', { date: TODAY, deps: LIVE_DEPS });
    assert.equal(r.baselineProvenance.source, 'snapshot');
    assert.match(r.baselineProvenance.sourceLabel, /NASA POWER/);
    assert.equal(r.baselineProvenance.period, '1991-2020');
  });
});

// ── §12.3 duration counting ────────────────────────────────────────────────
describe('§12.3 drought-duration counting and reset', () => {
  const flat = (v) => () => v;
  const dates = DATES;

  test('eight consecutive dry weeks count as 8 real weeks', () => {
    const r = engine.evaluateDuration({
      dates,
      precipByDate: new Map(dates.map((d) => [d, 0])),
      soilByDate: new Map(dates.map((d) => [d, 0.05])),
      expectedDaily: flat(2),
      fieldCapacity: 0.4,
    });
    assert.equal(r.weeks, 8);
    assert.equal(r.isEstimated, false);
    assert.equal(r.reason, null);
  });

  test('a wet week stops the count cleanly (not estimated)', () => {
    const precip = new Map(dates.map((d) => [d, 0]));
    // The week 8–14 days back is wet enough that both legs fail
    for (const d of dates.slice(-14, -7)) precip.set(d, 9);
    const r = engine.evaluateDuration({
      dates,
      precipByDate: precip,
      soilByDate: new Map(dates.map((d) => [d, 0.05])),
      expectedDaily: flat(2),
      fieldCapacity: 0.4,
    });
    assert.equal(r.weeks, 1);
    assert.equal(r.isEstimated, false);
  });

  test('a drought week with HIGH soil moisture is not a drought week', () => {
    const r = engine.evaluateDuration({
      dates,
      precipByDate: new Map(dates.map((d) => [d, 0])),
      soilByDate: new Map(dates.map((d) => [d, 0.35])), // above 60% of 0.4
      expectedDaily: flat(2),
      fieldCapacity: 0.4,
    });
    assert.equal(r.weeks, 0);
    assert.equal(r.isEstimated, false);
  });

  test('two consecutive days at expectation reset the streak (§12.3)', () => {
    const precip = new Map(dates.map((d) => [d, 0]));
    const pair = [dates[dates.length - 4], dates[dates.length - 3]];
    for (const d of pair) precip.set(d, 5); // ≥ the daily expectation of 2
    const r = engine.evaluateDuration({
      dates,
      precipByDate: precip,
      soilByDate: new Map(dates.map((d) => [d, 0.05])),
      expectedDaily: flat(2),
      fieldCapacity: 0.4,
    });
    assert.equal(r.weeks, 0);
    assert.equal(r.isEstimated, false);
    assert.equal(r.reason, 'precipitation reset');
  });

  test('a gap in the counted window yields no count and a stated reason', () => {
    const r = engine.evaluateDuration({
      dates,
      precipByDate: new Map(dates.map((d) => [d, 0])),
      soilByDate: new Map(dates.slice(0, 30).map((d) => [d, 0.05])), // archive stops 26 days ago
      expectedDaily: flat(2),
      fieldCapacity: 0.4,
    });
    assert.equal(r.weeks, null);
    assert.equal(r.isEstimated, true);
    assert.match(r.reason, /not fully covered/);
    // dates[0] is outside the 56-day window, so 29 of the 30 supplied days count
    assert.equal(r.coverage.soilDaysPresent, 29);
    assert.equal(r.coverage.lastSoilDate, dates[29]);
  });

  test('the 60%-of-field-capacity leg is district-specific (Bikaner FC = 0.18)', () => {
    // 0.12 is wet for Bikaner (0.66 × FC) but dry for Jalna (0.30 × FC)
    const args = {
      dates,
      precipByDate: new Map(dates.map((d) => [d, 0])),
      soilByDate: new Map(dates.map((d) => [d, 0.12])),
      expectedDaily: flat(2),
    };
    assert.equal(engine.evaluateDuration({ ...args, fieldCapacity: 0.18 }).weeks, 0);
    assert.equal(engine.evaluateDuration({ ...args, fieldCapacity: 0.40 }).weeks, 8);
  });
});

// ── §10.1 F4 trend ─────────────────────────────────────────────────────────
describe('§10.1 F4 — CWSI trend sourcing', () => {
  const ctx = {
    today: TODAY,
    fieldCapacity: 0.4,
    wiltingPoint: 0.2,
    currentSoilMoisture: 0.24,
    forecastHourlySoil: forecastStub({ soil: 0.3 }).hourlySoil,
  };

  test('five points, weekly, ending with the forecast-model current value', () => {
    const soilByDate = new Map(DATES.map((d) => [d, 0.2]));
    const r = engine.buildCwsiTrend({ ksCwsi }, { ...ctx, soilByDate });
    assert.equal(r.points.length, 5);
    assert.deepEqual(r.points.map((p) => p.date), [
      addDays(TODAY, -28), addDays(TODAY, -21), addDays(TODAY, -14), addDays(TODAY, -7), TODAY,
    ]);
    assert.deepEqual(r.points.map((p) => p.source).slice(0, 4),
      ['era5_land_reanalysis', 'era5_land_reanalysis', 'era5_land_reanalysis', 'era5_land_reanalysis']);
    assert.equal(r.points[4].source, 'forecast_model');
    assert.equal(r.points[4].cwsi, ksCwsi(0.4, 0.2, 0.24));
    assert.deepEqual(r.splicedDates, []);
    assert.deepEqual(r.truncatedDates, []);
  });

  test('a date missing from the archive is spliced from the forecast series and MARKED', () => {
    const target = addDays(TODAY, -7);
    const soilByDate = new Map(DATES.filter((d) => d !== target).map((d) => [d, 0.2]));
    const r = engine.buildCwsiTrend({ ksCwsi }, { ...ctx, soilByDate });
    assert.equal(r.points.length, 5);
    assert.deepEqual(r.splicedDates, [target]);
    assert.equal(r.points[3].source, 'era5_land_reanalysis_spliced_from_forecast_model');
  });

  test('a date neither source can supply is truncated, not invented', () => {
    const target = addDays(TODAY, -14);
    const soilByDate = new Map(DATES.filter((d) => d !== target).map((d) => [d, 0.2]));
    const r = engine.buildCwsiTrend({ ksCwsi }, { ...ctx, soilByDate, forecastHourlySoil: [] });
    assert.equal(r.points.length, 4);
    assert.deepEqual(r.truncatedDates, [target]);
    assert.equal(r.points[r.points.length - 1].date, TODAY); // always ends at "now"
  });
});

// ── §12.4 / §12.5 baselines ────────────────────────────────────────────────
describe('§12.4 snapshot seeding and §12.5 emergency fallback', () => {
  test('the committed snapshot seeds all four districts with a stated period', () => {
    assert.equal(climateCache.isSeeded(), true);
    for (const id of DISTRICT_IDS) {
      const b = climateCache.getMonthlyBaselines(id);
      assert.equal(b.source, 'snapshot', id);
      assert.equal(b.monthlyMm.length, 12, id);
      assert.equal(b.period, '1991-2020', id);
      assert.ok(b.fetchedAt && !Number.isNaN(Date.parse(b.fetchedAt)), id);
      assert.ok(b.monthlyMm.every((v) => Number.isFinite(v) && v >= 0), id);
    }
  });

  test('the previous-month baseline is the PREVIOUS month, not the same one', () => {
    // Regression guard: an off-by-one here silently applies this month's baseline
    // to the whole window and understates the expectation by ~half in a monsoon month.
    const b = climateCache.getMonthBaselines('jalna', '2026-10-08');
    const all = climateCache.getMonthlyBaselines('jalna').monthlyMm;
    assert.equal(b.baselineMonthlyMm, all[9]);  // October
    assert.equal(b.baselinePrevMonthMm, all[8]); // September
    assert.notEqual(b.baselineMonthlyMm, b.baselinePrevMonthMm);

    // …and January's previous month wraps to December of the previous year
    const jan = climateCache.getMonthBaselines('jalna', '2027-01-15');
    assert.equal(jan.baselineMonthlyMm, all[0]);
    assert.equal(jan.baselinePrevMonthMm, all[11]);
  });

  test('§12.5 fallback shape splits the monsoon share across Jun–Sep', () => {
    for (const id of DISTRICT_IDS) {
      const d = getDistrict(id);
      const mm = climateCache.fallbackMonthlyMm(d);
      assert.equal(mm.length, 12);
      const total = mm.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - d.fallbackMm.annual) < 0.05, `${id} totals ${total}`);
      const monsoonMonths = [5, 6, 7, 8];                       // Jun–Sep
      const monsoon = monsoonMonths.reduce((a, m) => a + mm[m], 0);
      assert.ok(Math.abs(monsoon - d.fallbackMm.monsoon) < 0.05, `${id} monsoon ${monsoon}`);
      // every monsoon month is wetter than every non-monsoon month
      const dry = mm.filter((_, i) => !monsoonMonths.includes(i));
      assert.ok(Math.min(...monsoonMonths.map((m) => mm[m])) > Math.max(...dry), id);
    }
  });

  test('an unreadable snapshot falls back to §12.5 and says so', () => {
    const fs = require('fs');
    const real = climateCache.SNAPSHOT_PATH;
    const backup = `${real}.test-bak`;
    fs.renameSync(real, backup);
    try {
      climateCache.resetCache();
      const b = climateCache.getMonthlyBaselines('jalna');
      assert.equal(b.source, 'fallback');
      assert.match(b.sourceLabel, /§12\.5/);
      assert.equal(b.period, null);
      assert.equal(climateCache.isSeeded(), false);
      // The fallback is still a usable baseline, not a zero
      assert.ok(b.monthlyMm.every((v) => v > 0));
    } finally {
      fs.renameSync(backup, real);
      climateCache.resetCache();
    }
  });

  test('an unknown district is rejected, never defaulted', () => {
    assert.throws(() => climateCache.getMonthlyBaselines('kolkata'), RangeError);
    assert.equal(getDistrict('KOLKATA'), undefined);
    assert.equal(getDistrict(' jalna ').id, 'jalna'); // URL keys are case/space tolerant
  });
});

// ── small shared helpers ───────────────────────────────────────────────────
describe('engine clock and calendar helpers', () => {
  test('the season-day is the IST day, not the UTC day (§11.9)', () => {
    assert.equal(engine.istToday(new Date('2026-10-08T13:00:00Z')), '2026-10-08');
    // 20:00 UTC is already tomorrow in IST
    assert.equal(engine.istToday(new Date('2026-10-08T20:00:00Z')), '2026-10-09');
    // 18:00 UTC = 23:30 IST, still today
    assert.equal(engine.istToday(new Date('2026-10-08T18:00:00Z')), '2026-10-08');
  });

  test('addDays crosses month, year and leap boundaries', () => {
    assert.equal(engine.addDays('2026-10-08', -8), '2026-09-30');
    assert.equal(engine.addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(engine.addDays('2028-02-28', 1), '2028-02-29'); // leap year
    assert.equal(engine.addDays('2027-02-28', 1), '2027-03-01');
    assert.equal(engine.addDays('2026-03-01', -1), '2026-02-28');
  });

  test('§11.8 aggregate quality derivation', () => {
    const q = engine.aggregateQuality;
    assert.equal(q({ a: 'LIVE', b: 'LIVE' }), 'LIVE');
    assert.equal(q({ a: 'LIVE', b: 'FALLBACK' }), 'PARTIAL');
    assert.equal(q({ a: 'FALLBACK', b: 'FALLBACK' }), 'OFFLINE');
    assert.equal(q({ a: 'FALLBACK', b: 'LIVE', c: 'FALLBACK' }), 'PARTIAL');
  });

  test('the canonical rounding keeps published numbers re-hashable (§14.3)', async () => {
    const r = await engine.computeDistrictWeather('anantapur', { date: TODAY, deps: LIVE_DEPS });
    for (const [k, v] of Object.entries(r.engineInput)) {
      if (typeof v === 'number') {
        // every numeric field lands on a scale the receipt can represent exactly
        const scaled = k === 'droughtWeeks' ? v : v * 1000;
        assert.equal(Math.abs(scaled - Math.round(scaled)) < 1e-6, true, `${k} = ${v}`);
      }
    }
  });
});

test('thresholds come from the core, never restated here', () => {
  // A guard for §14.2: this file must not grow its own copy of the tier table.
  assert.equal(THRESHOLDS.wsiMilliPercent.tier3, 70000);
  assert.equal(THRESHOLDS.payoutPerHectare[TIER.PREVENTED_SOWING], 12500);
  assert.ok(DISTRICT_IDS.length === 4);
});
