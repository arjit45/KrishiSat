// ─────────────────────────────────────────────────────────────────────────────
// F15 writer tests — §11.9, §23.1, §22.1 layers 1 and 7.
//
// The store is absent in these tests, which is the point: the writer must be
// fully exercisable (and its mapping fully checkable) with no database, because
// the mapping is the one thing here that can be wrong silently.
//
// The strongest test in this file is the constraint-membership sweep: every value
// `buildEntry` can produce is checked against the CHECK constraints declared in
// db/migrations/0001_recommendation_log.sql. A tier or a payout the table would
// reject is a runtime failure in production and a passing unit test otherwise —
// so the constraints are re-read from the migration rather than restated.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const writer = require('../services/recommendationLog');
const engine = require('../engines/deficitEngine');
const repo = require('../repositories/recommendations');
const { getDistrict, DISTRICT_IDS } = require('../config/districts');
const { ksCompute, ksReceipt, TIER } = await import('../core/ks_core.mjs');

const MIGRATION = fs.readFileSync(
  path.resolve(HERE, '../../db/migrations/0001_recommendation_log.sql'), 'utf8',
);

/** Pull the allowed values out of a `check (col in (...))` clause. */
function allowedValues(column) {
  const re = new RegExp(`${column}\\s+text[\\s\\S]{0,120}?check \\(${column} in \\(([^)]+)\\)`);
  const m = re.exec(MIGRATION);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
}

/** A complete engine result for the LIVE path, built from the shipped core. */
function result({ tier = null, wsiPct = 68.9, estimated = false, districtId = 'jalna' } = {}) {
  const input = {
    districtId,
    season: 'kharif',
    date: '2026-09-30',
    scenarioId: null,
    baselineMonthlyMm: 142.5,
    baselinePrevMonthMm: 118,
    expected30Mm: 139.5,
    actual30Mm: 100 - wsiPct,
    currentSoilMoisture: 0.18,
    currentSoilMoistureSource: 'forecast_model',
    historicalSoilMoistureSource: 'era5_land_reanalysis',
    fieldCapacity: 0.4,
    wiltingPoint: 0.2,
    cropStageId: 'flowering',
    cropStageMultiplier: 1,
    droughtWeeks: estimated ? 3 : 5,
    durationIsEstimated: estimated,
  };
  const receipt = ksReceipt(input);
  const output = ksCompute(input);
  return {
    district: { ...getDistrict(districtId) },
    season: 'kharif',
    seasonSource: 'user',
    engineInput: input,
    engineOutput: output,
    receipt: { receiptId: receipt.digest, canonicalInput: receipt.canonicalString },
    dataQuality: 'LIVE',
    seasonDate: '2026-09-30',
    degraded: false,
    degradedReason: null,
  };
}

describe('§11.9 entry mapping', () => {
  test('maps an engine result onto every documented field', () => {
    const entry = writer.buildEntry(result());
    assert.deepEqual(Object.keys(entry).sort(), [
      'aggregateQuality', 'canonicalInputHash', 'date', 'district', 'durationMode',
      'payoutPerHectare', 'payoutTier', 'receiptId', 'scenarioId', 'season',
      'severityLevel', 'wsi',
    ]);
    assert.equal(entry.district, 'jalna');
    assert.equal(entry.date, '2026-09-30');
    assert.equal(entry.season, 'kharif');
    assert.equal(entry.scenarioId, null);
    assert.equal(entry.aggregateQuality, 'LIVE');
    assert.equal(entry.durationMode, 'real');
    // The row must be verifiable exactly as a receipt is (§11.9), so the digest is
    // stored byte-identical to the one the API publishes.
    assert.equal(entry.receiptId, result().receipt.receiptId);
    assert.equal(entry.canonicalInputHash, entry.receiptId);
    assert.match(entry.receiptId, /^[0-9a-f]{64}$/);
  });

  test('durationMode records the mode the clauses were decided in (§12.3)', () => {
    assert.equal(writer.buildEntry(result({ estimated: true })).durationMode, 'estimated');
    assert.equal(writer.buildEntry(result({ estimated: false })).durationMode, 'real');
  });

  test('a degraded result is not recordable at all', () => {
    const degraded = { ...result(), degraded: true, engineOutput: null, receipt: null, degradedReason: 'forecast down' };
    assert.equal(writer.buildEntry(degraded), null);
    assert.equal(writer.buildEntry(null), null);
    assert.equal(writer.buildEntry({}), null);
  });

  test('every value buildEntry can emit satisfies the table constraints', () => {
    const qualities = ['LIVE', 'PARTIAL', 'OFFLINE'];
    const tiers = new Set();
    const payouts = new Set();
    const severities = new Set();
    const durationModes = new Set();

    // Sweep the whole WSI range in both duration modes, at a sowing and a
    // non-sowing stage, so every reachable tier/severity/payout is exercised.
    for (let wsiPct = 0; wsiPct <= 100; wsiPct += 0.25) {
      for (const estimated of [true, false]) {
        for (const stage of ['flowering', 'pre_sowing']) {
          const r = result({ wsiPct, estimated });
          r.engineInput.cropStageId = stage;
          r.engineInput.cropStageMultiplier = 1;
          r.engineInput.droughtWeeks = estimated ? 0 : 6;
          const out = ksCompute(r.engineInput);
          r.engineOutput = out;
          r.receipt = { receiptId: ksReceipt(r.engineInput).digest };
          for (const q of qualities) {
            const entry = writer.buildEntry({ ...r, dataQuality: q });
            tiers.add(entry.payoutTier);
            payouts.add(entry.payoutPerHectare);
            severities.add(entry.severityLevel);
            durationModes.add(entry.durationMode);
            // wsi is numeric(5,2) and checked 0..100
            assert.ok(entry.wsi >= 0 && entry.wsi <= 100, `wsi ${entry.wsi}`);
            assert.equal(Math.round(entry.wsi * 100) / 100, entry.wsi, `wsi precision ${entry.wsi}`);
          }
        }
      }
    }

    const tierIn = allowedValues('payout_tier');
    const severityIn = allowedValues('severity_level');
    const qualityIn = allowedValues('aggregate_quality');
    const durationIn = allowedValues('duration_mode');
    const districtIn = allowedValues('district');
    assert.ok(tierIn && severityIn && qualityIn && durationIn && districtIn, 'migration constraints were not parsed');
    for (const t of tiers) assert.ok(tierIn.includes(t), `table would reject payoutTier ${t}`);
    for (const s of severities) assert.ok(severityIn.includes(s), `table would reject severityLevel ${s}`);
    for (const q of qualities) assert.ok(qualityIn.includes(q), `table would reject aggregateQuality ${q}`);
    for (const d of durationModes) assert.ok(durationIn.includes(d), `table would reject durationMode ${d}`);
    for (const id of DISTRICT_IDS) assert.ok(districtIn.includes(id), `table would reject district ${id}`);

    // The five published amounts of §12.1 and nothing else
    const payoutIn = [...payouts].sort((a, b) => a - b);
    assert.deepEqual(payoutIn, [0, 12500, 25000, 37500, 50000]);
    assert.equal(tiers.size, 5, 'all five tiers are reachable');
  });

  test('the retention window is the §23.1 one', () => {
    assert.equal(writer.RETENTION_DAYS, 180);
    assert.equal(repo._internal.RETENTION_DAYS, 180);
  });
});

describe('idempotency contract (§21.2, F15)', () => {
  test('an unchanged input yields an unchanged hash, so the insert is a no-op', () => {
    const a = writer.buildEntry(result());
    const b = writer.buildEntry(result());
    assert.equal(a.canonicalInputHash, b.canonicalInputHash);

    // …and a genuinely different recommendation is a different key
    const scenario = result();
    scenario.engineInput = { ...scenario.engineInput, scenarioId: 'jalna-2016' };
    scenario.receipt = { receiptId: ksReceipt(scenario.engineInput).digest };
    assert.notEqual(writer.buildEntry(scenario).canonicalInputHash, a.canonicalInputHash);

    const rabi = result();
    rabi.engineInput = { ...rabi.engineInput, season: 'rabi' };
    rabi.receipt = { receiptId: ksReceipt(rabi.engineInput).digest };
    assert.notEqual(writer.buildEntry(rabi).canonicalInputHash, a.canonicalInputHash);
  });

  test('a duplicate is reported as a duplicate, never as an error', async () => {
    const original = repo.append;
    // A faithful stand-in for the table's UNIQUE constraint: the writer's
    // contract is that appending the same hash twice is a reported no-op.
    const keys = new Set();
    repo.append = async (entry) => {
      if (keys.has(entry.canonicalInputHash)) return { stored: false, duplicate: true };
      keys.add(entry.canonicalInputHash);
      return { stored: true, id: `uuid-${keys.size}` };
    };
    try {
      const first = await writer.runDailyJob({ date: '2026-09-30', deps: stubDeps() });
      const second = await writer.runDailyJob({ date: '2026-09-30', deps: stubDeps() });
      const third = await writer.runDailyJob({ date: '2026-09-30', deps: stubDeps() });
      assert.equal(first.counts.stored, 4);
      assert.equal(first.counts.duplicates, 0);
      assert.equal(second.counts.stored, 0);
      assert.equal(second.counts.duplicates, 4);
      assert.equal(second.counts.failed, 0);
      assert.equal(third.counts.duplicates, 4);   // idempotent however often it runs
      assert.equal(keys.size, 4);                 // …and only four rows ever exist
      assert.equal(second.status, 'ok');
      assert.equal(second.logWritable, false);    // no store configured in a test run
    } finally {
      repo.append = original;
    }
  });
});

describe('the daily job', () => {
  test('appends one entry per district for the season-day', async () => {
    const seen = [];
    const original = repo.append;
    repo.append = async (entry) => {
      seen.push(entry);
      return { stored: true, id: `uuid-${seen.length}` };
    };
    try {
      const summary = await writer.runDailyJob({ date: '2026-09-30', deps: stubDeps() });
      assert.equal(seen.length, 4);
      assert.deepEqual(seen.map((e) => e.district), DISTRICT_IDS);
      assert.ok(seen.every((e) => e.date === '2026-09-30'));
      assert.ok(seen.every((e) => e.season === 'kharif')); // Oct–Nov auto-detects Kharif
      assert.equal(summary.counts.stored, 4);
      assert.equal(summary.counts.failed, 0);
      assert.deepEqual(summary.retention.days, 180);
      assert.equal(typeof summary.runAt, 'string');
      assert.equal(summary.date, '2026-09-30');
    } finally {
      repo.append = original;
    }
  });

  test('a degraded district is skipped, not recorded with a substituted value', async () => {
    const seen = [];
    const original = repo.append;
    repo.append = async (entry) => { seen.push(entry); return { stored: true }; };
    const deps = stubDeps({ failForecastFor: 'bikaner' });
    try {
      const summary = await writer.runDailyJob({ date: '2026-09-30', deps });
      assert.equal(seen.length, 3);
      assert.ok(!seen.some((e) => e.district === 'bikaner'));
      const skipped = summary.districts.find((d) => d.district === 'bikaner');
      assert.equal(skipped.skipped, true);
      assert.equal(skipped.stored, false);
      assert.match(skipped.reason, /precipitation source unavailable/);
      assert.equal(summary.counts.skipped, 1);
      assert.equal(summary.counts.failed, 0); // "nothing to record" is not a failure
    } finally {
      repo.append = original;
    }
  });

  test('an unavailable store is reported, not thrown, and never blocks the loop', async () => {
    const summary = await writer.runDailyJob({ date: '2026-09-30', deps: stubDeps() });
    // No SUPABASE_URL in the test process, so the real repository reports that.
    assert.equal(summary.counts.failed, 4);
    assert.equal(summary.logConfigured, false);
    assert.equal(summary.logWritable, false);
    assert.equal(summary.status, 'ok');       // the JOB ran; the STORE did not
    assert.equal(summary.retention.reason, 'not-configured');
    assert.ok(summary.districts.every((d) => d.reason === 'not-configured'));
  });

  test('one district throwing cannot stop the others', async () => {
    const original = repo.append;
    let n = 0;
    repo.append = async () => {
      n += 1;
      if (n === 2) throw new Error('socket hang up');
      return { stored: true };
    };
    try {
      const summary = await writer.runDailyJob({ date: '2026-09-30', deps: stubDeps() });
      assert.equal(summary.counts.stored, 3);
      assert.equal(summary.counts.failed, 1);
      assert.match(summary.districts[1].reason, /socket hang up/);
    } finally {
      repo.append = original;
    }
  });
});

/** Mocked externals: dry synthetic series, so the job runs with no network. */
function stubDeps({ failForecastFor = null } = {}) {
  const dates = Array.from({ length: 57 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 30) + (i - 56) * 86400000).toISOString().slice(0, 10));
  return {
    fetchForecast: async (point) => {
      if (failForecastFor && Math.abs(point.lat - getDistrict(failForecastFor).lat) < 1e-6) {
        throw new Error('forecast timeout');
      }
      return {
        daily: dates.map((date) => ({ date, precipMm: 0.4 })),
        currentSoilMoisture: 0.2,
        currentSoilMoistureTime: '2026-09-30T18:30',
        currentPrecipMm: 0,
        hourlySoil: dates.flatMap((date) => Array.from({ length: 24 }, (_, h) => ({
          time: `${date}T${String(h).padStart(2, '0')}:00`, value: 0.2,
        }))),
      };
    },
    fetchArchiveSoil: async () => ({
      daily: dates.map((date) => ({ date, soilMoisture: 0.2 })),
      hoursPerDay: 24,
    }),
  };
}
