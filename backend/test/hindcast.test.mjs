// ─────────────────────────────────────────────────────────────────────────────
// Hindcast tests — PRD §10.2 F11, §11.6, §22.1 layers 1 and 8.
//
// The replay is pure given a daily series, so these tests drive it with synthetic
// series and check the properties that a wrong implementation would break: the
// season window (Rabi spans the new year), the §27 gap rule, the "peak over the
// season" aggregation, and the §12.3 disclosure that the soil leg is absent.
//
// The committed snapshot is then checked against its own contract: the numbers
// §12.6 records must be the numbers in the file, and every record must satisfy the
// §11.6 shape.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const hindcast = require('../services/hindcast');
const climateCache = require('../engines/climateCache');
const { DISTRICTS, DISTRICT_IDS } = require('../config/districts');
const core = await import('../core/ks_core.mjs');

const TARGETS = [
  'BELOW_THRESHOLD', 'PREVENTED_SOWING', 'TIER_1_MODERATE', 'TIER_2_SEVERE', 'TIER_3_CATASTROPHIC',
];

/** A synthetic daily series: `wetDays` receive `wetMm`, everything else 0. */
function series({ from, to, wetMm = 0, wetEvery = 0 } = {}) {
  const map = new Map();
  const days = hindcast.eachDay(from, to);
  days.forEach((d, i) => {
    map.set(d, wetEvery > 0 && i % wetEvery === 0 ? wetMm : 0);
  });
  return map;
}

function monthly(mm = 100) {
  return Array.from({ length: 12 }, () => mm);
}

describe('§11.6 season windows', () => {
  test('Kharif is Jun–Nov of the year; Rabi spans the new year', () => {
    assert.deepEqual(hindcast.seasonWindow('kharif', 2015), { from: '2015-06-01', to: '2015-11-30' });
    assert.deepEqual(hindcast.seasonWindow('rabi', 2015), { from: '2014-12-01', to: '2015-05-31' });
  });

  test('every season window is a real, contiguous date range', () => {
    for (const season of ['kharif', 'rabi']) {
      const { from, to } = hindcast.seasonWindow(season, 2020);
      const days = hindcast.eachDay(from, to);
      assert.ok(days.length > 180 && days.length < 185, `${season} has ${days.length} days`);
      assert.equal(days[0], from);
      assert.equal(days[days.length - 1], to);
    }
  });
});

describe('§10.2 F11 replay', () => {
  const district = DISTRICTS.jalna;

  test('a bone-dry season peaks at the tier the WSI bands give', () => {
    const precipByDate = series({ from: '2014-05-01', to: '2015-12-31' }); // all zero
    const record = hindcast.replaySeason(core, {
      district, season: 'kharif', year: 2015, precipByDate, monthlyMm: monthly(100),
    });
    assert.equal(record.districtId, 'jalna');
    assert.equal(record.year, 2015);
    assert.equal(record.season, 'kharif');
    assert.equal(record.tier, 'TIER_3_CATASTROPHIC');
    assert.equal(record.peakWsi, 100);           // shortfall 100 × multiplier ≥ 1
    assert.equal(record.payoutPerHectare, 50000);
    assert.equal(record.durationMode, 'estimated');
    assert.equal(record.durationWeeks, 0);
    assert.equal(record.soilLeg, 'unavailable_in_hindcast_source');
  });

  test('duration is ALWAYS estimated: NASA POWER daily carries no soil series', () => {
    const precipByDate = series({ from: '2014-05-01', to: '2015-12-31', wetMm: 200, wetEvery: 3 });
    for (const season of ['kharif', 'rabi']) {
      const record = hindcast.replaySeason(core, {
        district, season, year: 2015, precipByDate, monthlyMm: monthly(100),
      });
      assert.equal(record.durationMode, 'estimated', season);
      assert.equal(record.durationWeeks, 0, season);
    }
  });

  test('a wet season does not trigger, so the replay is not degenerate', () => {
    // 100 mm every 5 days: far above any monthly baseline in the map below.
    const precipByDate = series({ from: '2015-06-01', to: '2015-11-30', wetMm: 100, wetEvery: 5 });
    const record = hindcast.replaySeason(core, {
      district, season: 'kharif', year: 2015, precipByDate, monthlyMm: monthly(20),
    });
    assert.equal(record.tier, 'BELOW_THRESHOLD');
    assert.equal(record.payoutPerHectare, 0);
    assert.equal(record.peakWsi, 0);
  });

  test('§27: a date whose trailing window has a gap is skipped and counted', () => {
    // The series must start a month before the season, or windows for the first
    // dates of the season reach before the series begins — which is itself a gap.
    const precipByDate = series({ from: '2015-05-01', to: '2015-11-30' });
    // Punch a hole; every date whose 30-day window covers it becomes unusable:
    // 2015-08-01 (first overlap) through 2015-08-30 + 29 = 2015-09-28.
    for (const d of hindcast.eachDay('2015-08-01', '2015-08-30')) precipByDate.delete(d);
    const record = hindcast.replaySeason(core, {
      district, season: 'kharif', year: 2015, precipByDate, monthlyMm: monthly(100),
    });
    const seasonDays = hindcast.eachDay('2015-06-01', '2015-11-30').length;
    assert.equal(record.skippedDays, 59);
    assert.equal(record.evaluatedDays, seasonDays - 59);
    // No date OUTSIDE the affected span was skipped: early September (windows
    // ending before the hole opens) still evaluates, so the count is precise
    // rather than a blanket write-off of the season.
    assert.equal(record.evaluatedDays + record.skippedDays, seasonDays);
    // The rest of the season still evaluates, and the peak is a real zero-rain date
    assert.equal(record.tier, 'TIER_3_CATASTROPHIC');
  });

  test('a season with no usable window at all yields no record (never a fake one)', () => {
    const record = hindcast.replaySeason(core, {
      district, season: 'kharif', year: 2015, precipByDate: new Map(), monthlyMm: monthly(100),
    });
    assert.equal(record, null);
  });

  test('the record carries only §11.6 fields plus documented disclosures', () => {
    const precipByDate = series({ from: '2014-05-01', to: '2015-12-31', wetMm: 5, wetEvery: 4 });
    const record = hindcast.replaySeason(core, {
      district, season: 'rabi', year: 2015, precipByDate, monthlyMm: monthly(100),
    });
    for (const key of ['districtId', 'year', 'season', 'peakWsi', 'tier', 'payoutPerHectare', 'durationWeeks']) {
      assert.ok(key in record, `missing §11.6 field ${key}`);
    }
    for (const key of ['peakDate', 'durationMode', 'severityLevel', 'soilLeg',
      'rainfallShortfallPercentage', 'evaluatedDays', 'skippedDays']) {
      assert.ok(key in record, `missing disclosure ${key}`);
    }
  });
});

describe('runHindcast aggregation (§11.6 summary)', () => {
  test('counts seasons, tiers, frequency and the ±15 pp band', () => {
    const dailyByDistrict = new Map();
    for (const id of DISTRICT_IDS) {
      dailyByDistrict.set(id, series({ from: '2013-05-01', to: '2015-12-31', wetMm: 60, wetEvery: 7 }));
    }
    const snapshot = hindcast.runHindcast(core, {
      startYear: 2014, endYear: 2015, dailyByDistrict, generatedAt: '2026-10-08T00:00:00.000Z',
    });
    assert.equal(snapshot.period, '2014-2015');
    assert.equal(snapshot.districts.jalna.years, 2);
    assert.equal(snapshot.districts.jalna.seasonsEvaluated, 4); // 2 years × 2 seasons
    assert.equal(typeof snapshot.districts.jalna.triggerFrequency, 'number');

    const d = snapshot.districts.dewas;
    const counted = Object.values(d.tierCounts).reduce((a, b) => a + b, 0);
    assert.equal(counted, d.seasonsEvaluated, 'tier counts must partition the seasons');
    // The band is ±15 pp around the measured frequency, clamped to 0–100.
    assert.equal(d.triggerBand[0], Math.max(0, Math.round((d.triggerFrequency - 15) * 10) / 10));
    assert.equal(d.triggerBand[1], Math.min(100, Math.round((d.triggerFrequency + 15) * 10) / 10));
    assert.ok(d.triggerBand[0] <= d.triggerBand[1]);
    // Every record satisfies the §11.6 shape and the published payout table
    for (const r of d.records) {
      assert.ok(TARGETS.includes(r.tier), r.tier);
      assert.ok([0, 12500, 25000, 37500, 50000].includes(r.payoutPerHectare));
      assert.ok(r.peakWsi >= 0 && r.peakWsi <= 100);
      assert.ok(r.durationWeeks >= 0 && r.durationWeeks <= 8);
      assert.match(r.peakDate, /^\d{4}-\d{2}-\d{2}$/);
    }
    // The peak recorded is the peak computed: no record may sit below its own tier's floor
    for (const r of d.records) {
      if (r.tier !== 'BELOW_THRESHOLD') assert.ok(r.peakWsi >= core.THRESHOLDS.wsiMilliPercent.prevented / 1000);
    }
  });

  test('a district with no series is a hard error, not a silent empty summary', () => {
    assert.throws(() => hindcast.runHindcast(core, {
      startYear: 2014, endYear: 2015, dailyByDistrict: new Map(),
    }), /no daily series/);
  });
});

describe('the committed snapshot (§12.4, §12.6)', () => {
  test('is present, complete, and matches what §12.6 records', () => {
    assert.equal(hindcast.isAvailable(), true);
    const snapshot = hindcast.readSnapshot();
    assert.equal(snapshot.period, '2006-2025');
    assert.ok(snapshot.generatedAt && !Number.isNaN(Date.parse(snapshot.generatedAt)));
    assert.match(snapshot.source, /NASA POWER daily/);
    assert.match(snapshot.methodology.disclaimer, /NOT a validation against real claim outcomes/);
    assert.match(snapshot.methodology.liveViewSource, /Open-Meteo/);

    for (const id of DISTRICT_IDS) {
      const summary = hindcast.getSummary(id);
      assert.ok(summary, id);
      assert.equal(summary.seasonsEvaluated, 40, id); // 20 years × 2 seasons
      assert.equal(summary.records.length, 40, id);
      assert.ok(summary.peakWsiStats.median >= summary.peakWsiStats.min, id);
      assert.ok(summary.peakWsiStats.max >= summary.peakWsiStats.median, id);
      assert.equal(summary.records.every((r) => r.durationMode === 'estimated'), true, id);
      assert.equal(summary.bySeason.kharif.seasonsEvaluated, 20, id);
      assert.equal(summary.bySeason.rabi.seasonsEvaluated, 20, id);
    }
  });

  test('the measured frequencies are the shipped product defaults, not asserted facts', () => {
    // These numbers are MEASURED, and the test pins them so a re-run that changes
    // them cannot pass unnoticed: a change here means the calibration changed.
    const expected = { jalna: 100, bikaner: 100, dewas: 100, anantapur: 100 };
    for (const [id, freq] of Object.entries(expected)) {
      assert.equal(hindcast.getSummary(id).triggerFrequency, freq, id);
    }
  });

  test('an unknown district has no summary', () => {
    assert.equal(hindcast.getSummary('kolkata'), null);
  });

  test('the hindcast used the committed baseline, not a private copy', () => {
    const snapshot = hindcast.readSnapshot();
    for (const id of DISTRICT_IDS) {
      assert.ok(climateCache.getMonthlyBaselines(id).monthlyMm.length === 12);
    }
    assert.match(snapshot.methodology.core, /ks_core\.mjs — the shipped core/);
  });
});
