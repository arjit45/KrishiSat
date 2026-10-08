// ─────────────────────────────────────────────────────────────────────────────
// API / contract tests — PRD §22.1 layer 6, §18, §15.
//
// Hermetic: the engine's compute function is replaced BEFORE server.js is
// required, so the route table is exercised without a single outbound call. The
// stub is deliberately boring and the assertions are about the CONTRACT — field
// names, status codes, bounds, headers — because that is the layer the core and
// engine suites cannot cover.
//
// The LIVE path (real Open-Meteo + NASA POWER) is verified separately by the
// smoke test recorded in the PRD verification notes, not here: a test that needs
// the network is a test that fails on a plane.
// ─────────────────────────────────────────────────────────────────────────────
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_PATH = path.resolve(HERE, '../core/ks_core.mjs');

const { ksCompute, ksReceipt } = await import('../core/ks_core.mjs');
const engine = require('../engines/deficitEngine');
const { DISTRICT_IDS } = require('../config/districts');

// ── Stub the engine before the server captures its reference ────────────────
const realCompute = engine.computeDistrictWeather;

/** A complete, deterministic engine result for the LIVE path. */
function stubLive(districtId) {
  const input = {
    districtId,
    season: 'kharif',
    date: '2026-09-30',
    scenarioId: null,
    baselineMonthlyMm: 142.5,
    baselinePrevMonthMm: 118,
    expected30Mm: 139.5,
    actual30Mm: 86.1,
    currentSoilMoisture: 0.18,
    currentSoilMoistureSource: 'forecast_model',
    historicalSoilMoistureSource: 'era5_land_reanalysis',
    fieldCapacity: 0.4,
    wiltingPoint: 0.2,
    cropStageId: 'flowering',
    cropStageMultiplier: 1.8,
    droughtWeeks: 5,
    durationIsEstimated: false,
  };
  const receipt = ksReceipt(input);
  return {
    district: {
      id: districtId, name: 'Jalna', state: 'Maharashtra', zone: 'Marathwada',
      agroZone: 'Marathwada Drought-Prone Zone', lat: 19.8297, lon: 75.88,
      primaryCrops: ['Cotton'], fieldCapacity: 0.4, wiltingPoint: 0.2,
    },
    season: 'kharif',
    seasonSource: 'user',
    cropStage: { label: 'Flowering & Pollination', stageId: 'flowering', multiplier: 1.8, month: 'September', isOffSeason: false },
    baselineProvenance: { source: 'snapshot', sourceLabel: 'NASA POWER Climatology API (MERRA-2) 1991-2020', period: '1991-2020', fetchedAt: '2026-10-08T13:08:22.948Z', baselineMonthlyMm: 142.5, baselinePrevMonthMm: 118 },
    sources: { openMeteoForecast: 'LIVE', openMeteoArchive: 'LIVE', nasaPower: 'LIVE' },
    fallbackReasons: [],
    dataQuality: 'LIVE',
    seasonDate: '2026-09-30',
    sourceLabels: { currentSoilMoisture: 'x', historicalSoilMoisture: 'y' },
    degraded: false,
    degradedReason: null,
    engineInput: input,
    engineOutput: ksCompute(input),
    receipt: { receiptId: receipt.digest, algorithm: 'sha256', canonicalEncoding: 'scaled-int-v1', canonicalInput: receipt.canonicalString },
    expected30Mm: 139.5, actual30Mm: 86.1, monthToDateMm: 87.9, monthToDateExpectedMm: 92,
    soilMoistureRaw: 0.18, cwsiTrend: [0.51, 0.66, 0.79, 0.92, 1],
    cwsiTrendPoints: [], cwsiTrendSpliced: [], cwsiTrendTruncated: [],
    durationCoverage: { windowDays: 56, soilDaysPresent: 56, precipDaysPresent: 56, lastSoilDate: '2026-09-30', lastForecastDate: '2026-09-30' },
    durationReason: null,
  };
}

/** A degraded result: the precipitation source is unavailable. */
function stubDegraded(districtId) {
  return {
    ...stubLive(districtId),
    degraded: true,
    degradedReason: 'precipitation source unavailable — no shortfall can be computed',
    engineInput: null,
    engineOutput: null,
    receipt: null,
    actual30Mm: null,
    monthToDateMm: null,
    soilMoistureRaw: null,
    cwsiTrend: [],
    dataQuality: 'PARTIAL',
    sources: { openMeteoForecast: 'FALLBACK', openMeteoArchive: 'LIVE', nasaPower: 'LIVE' },
    fallbackReasons: ['Open-Meteo forecast: timeout'],
  };
}

engine.computeDistrictWeather = async (districtId) =>
  (districtId === 'bikaner' ? stubDegraded(districtId) : stubLive(districtId));

const app = require('../server.js');
const core = await import('../core/ks_core.mjs');

let server;
let base;

before(async () => {
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret';
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  engine.computeDistrictWeather = realCompute;
  if (server) await new Promise((resolve) => server.close(resolve));
});

const get = (p, init) => fetch(`${base}${p}`, init);
const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ── §18.8 /api/health ──────────────────────────────────────────────────────
describe('§18.8 GET /api/health', () => {
  test('reports the core version and the checksum of the committed bytes', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.coreVersion, core.KS_VERSION);
    const expected = `sha256:${(await import('node:crypto')).createHash('sha256')
      .update(fs.readFileSync(CORE_PATH)).digest('hex')}`;
    assert.equal(body.coreChecksum, expected);
    assert.equal(typeof body.apiStatus.openMeteo, 'string');
    assert.equal(body.apiStatus.nasaPower, 'UP');       // committed snapshot is present
    assert.equal(body.instance.climateSeeded, true);
    // The log block can never fail the request (§16.2) — it is present, not required.
    assert.equal(typeof body.log, 'object');
    assert.equal(body.log.reachable, false);            // no database in a test run
  });
});

// ── §20.1 /ks_core.mjs ─────────────────────────────────────────────────────
describe('§20.1 GET /ks_core.mjs', () => {
  test('serves the exact committed bytes as text/javascript with its checksum', async () => {
    const res = await get('/ks_core.mjs');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    const body = await res.text();
    assert.equal(body, fs.readFileSync(CORE_PATH, 'utf8'));
    const health = await (await get('/api/health')).json();
    assert.equal(res.headers.get('x-core-checksum'), health.coreChecksum);
    assert.match(res.headers.get('cache-control'), /max-age/);
  });

  test('the served module recomputes a receipt the server issued (F10, in-process)', async () => {
    const weather = await (await get('/api/weather/jalna?season=kharif')).json();
    assert.equal(weather.receipt.algorithm, 'sha256');
    assert.equal(weather.receipt.canonicalEncoding, 'scaled-int-v1');
    // The published canonical input rehashes with the core's own receipt primitive
    // applied to the parsed input — the same thing the browser verification view does.
    const recomputed = ksReceipt(JSON.parse(JSON.stringify(stubLive('jalna').engineInput)));
    assert.equal(recomputed.canonicalString, weather.receipt.canonicalInput);
    assert.equal(recomputed.digest, weather.receipt.receiptId);
  });
});

// ── §18.1 /api/districts ───────────────────────────────────────────────────
describe('§18.1 GET /api/districts', () => {
  test('returns one summary per registry district, in the documented shape', async () => {
    const res = await get('/api/districts');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 4);
    for (const row of body) {
      assert.deepEqual(Object.keys(row).sort(),
        ['cropStage', 'dataQuality', 'id', 'name', 'payoutTier', 'severity', 'state', 'wsi', 'zone']);
      assert.match(row.dataQuality, /^(LIVE|PARTIAL|OFFLINE)$/);
      assert.match(row.severity, /^(NORMAL|MODERATE_DEFICIT|SEVERE_DROUGHT|CATASTROPHIC_DROUGHT|PREVENTED_SOWING)$/);
    }
  });

  test('a degraded district reports null, not a substituted zero', async () => {
    const body = await (await get('/api/districts')).json();
    const bikaner = body.find((d) => d.id === 'bikaner');
    assert.equal(bikaner.wsi, null);
    assert.equal(bikaner.dataQuality, 'PARTIAL');
    assert.equal(bikaner.severity, 'NORMAL');
  });

  test('an invalid season is rejected', async () => {
    assert.equal((await get('/api/districts?season=monsoon')).status, 400);
  });
});

// ── §18.2 /api/weather/:district ───────────────────────────────────────────
describe('§18.2 GET /api/weather/:district', () => {
  test('publishes the documented top-level shape', async () => {
    const body = await (await get('/api/weather/jalna?season=kharif')).json();
    for (const key of ['district', 'date', 'season', 'seasonSource', 'cropStage',
      'parametricDeficitEngine', 'receipt', 'sourceQuality', 'fallbackReasons',
      'methodologyNotes', 'attribution']) {
      assert.ok(key in body, `missing ${key}`);
    }
    assert.equal(body.season, 'kharif');
    assert.equal(body.seasonSource, 'user');
    assert.equal(body.cropStage.stageId, 'flowering');
    assert.equal(body.district.fieldCapacity, 0.4);
    assert.equal(body.receipt.canonicalEncoding, 'scaled-int-v1');
    assert.match(body.receipt.createdAt, /\+05:30$/); // IST, per the §18.2 example
    assert.ok(Array.isArray(body.methodologyNotes) && body.methodologyNotes.length >= 8);
    assert.ok(body.attribution.some((a) => a.includes('Open-Meteo')));
    assert.ok(body.attribution.some((a) => a.includes('OpenStreetMap')));
  });

  test('every §18.2 engine field is present and none is invented', async () => {
    const { parametricDeficitEngine: e } = await (await get('/api/weather/jalna?season=kharif')).json();
    for (const key of ['baselineMonthlyMm', 'expected30Mm', 'actual30Mm', 'monthToDateMm',
      'monthToDateExpectedMm', 'rainfallShortfallPercentage', 'cropStageMultiplier',
      'weightedShortfallIndex', 'soilMoistureRaw', 'soilMoistureRawSource', 'fieldCapacity',
      'wiltingPoint', 'soilMoistureDeficitPercentage', 'cwsiProxy', 'cwsiTrend',
      'droughtDurationWeeks', 'durationIsEstimated', 'isTriggerMet', 'severityLevel',
      'payoutTier', 'payoutPerHectare', 'percentSumInsured', 'dataSource', 'dataQuality']) {
      assert.ok(key in e, `missing ${key}`);
    }
    // §18.2's worked example, reproduced by the shipped core
    assert.equal(Math.round(e.weightedShortfallIndex * 10) / 10, 68.9);
    assert.equal(e.payoutTier, 'TIER_2_SEVERE');
    assert.equal(e.severityLevel, 'SEVERE_DROUGHT');
    assert.equal(e.payoutPerHectare, 37500);
    assert.equal(e.percentSumInsured, 75);
    assert.equal(e.dataQuality, 'LIVE');
  });

  test('a degraded district is explicitly marked and carries no receipt', async () => {
    const body = await (await get('/api/weather/bikaner')).json();
    assert.equal(body.parametricDeficitEngine.actual30Mm, null);
    assert.equal(body.parametricDeficitEngine.weightedShortfallIndex, null);
    assert.equal(body.receipt, null);
    assert.equal(body.parametricDeficitEngine.dataQuality, 'PARTIAL');
    assert.match(body.parametricDeficitEngine.dataSource, /Degraded/);
    assert.ok(body.fallbackReasons.length >= 1);
  });

  test('unknown district → 404, invalid season → 400 (§15.2)', async () => {
    assert.equal((await get('/api/weather/nope')).status, 404);
    assert.deepEqual(await (await get('/api/weather/nope')).json(), { error: 'District not found.' });
    assert.equal((await get('/api/weather/jalna?season=monsoon')).status, 400);
    assert.equal((await get('/api/weather/JALNA')).status, 200); // key is case-tolerant
  });
});

// ── §18.3 /api/calculate-payout ────────────────────────────────────────────
describe('§18.3 POST /api/calculate-payout', () => {
  test('the §18.3 example returns the §18.3 response, exactly those four fields', async () => {
    const res = await post('/api/calculate-payout', {
      weightedShortfallIndex: 68.9, droughtWeeks: 5, durationIsEstimated: false,
      cropStage: 'flowering', season: 'kharif',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      payoutPerHectare: 37500, tier: 'TIER_2_SEVERE', tierLabel: 'Severe', percentSumInsured: 75,
    });
  });

  test('tier boundaries hold through the HTTP layer', async () => {
    const call = (wsi, weeks, est, stage) => post('/api/calculate-payout', {
      weightedShortfallIndex: wsi, droughtWeeks: weeks, durationIsEstimated: est,
      cropStage: stage, season: 'kharif',
    }).then((r) => r.json());

    assert.equal((await call(69.999, 0, true, 'flowering')).tier, 'TIER_2_SEVERE');
    assert.equal((await call(70, 0, true, 'flowering')).tier, 'TIER_3_CATASTROPHIC');
    assert.equal((await call(49.999, 0, true, 'flowering')).tier, 'TIER_1_MODERATE');
    assert.equal((await call(50, 0, true, 'flowering')).tier, 'TIER_2_SEVERE');
    assert.equal((await call(35, 0, true, 'flowering')).tier, 'TIER_1_MODERATE');
    assert.equal((await call(34.999, 0, true, 'flowering')).tier, 'BELOW_THRESHOLD');
    assert.equal((await call(25, 0, true, 'pre_sowing')).tier, 'PREVENTED_SOWING');
    assert.equal((await call(25, 0, true, 'flowering')).tier, 'BELOW_THRESHOLD');
    // §29.3: WSI 30 with 6 real weeks is Tier 3, and the OR-clause is off when estimated
    assert.equal((await call(30, 6, false, 'flowering')).tier, 'TIER_3_CATASTROPHIC');
    assert.equal((await call(30, 6, true, 'flowering')).tier, 'BELOW_THRESHOLD');
  });

  test('invalid bodies are rejected with 400 and a generic message (§15.2, §15.9)', async () => {
    const bad = [
      {},
      { weightedShortfallIndex: 200, droughtWeeks: 1, durationIsEstimated: true, cropStage: 'flowering', season: 'kharif' },
      { weightedShortfallIndex: -1, droughtWeeks: 1, durationIsEstimated: true, cropStage: 'flowering', season: 'kharif' },
      { weightedShortfallIndex: 50, droughtWeeks: 9, durationIsEstimated: true, cropStage: 'flowering', season: 'kharif' },
      { weightedShortfallIndex: 50, droughtWeeks: 1, durationIsEstimated: 'yes', cropStage: 'flowering', season: 'kharif' },
      { weightedShortfallIndex: 50, droughtWeeks: 1, durationIsEstimated: true, cropStage: 'oracle', season: 'kharif' },
      { weightedShortfallIndex: 50, droughtWeeks: 1, durationIsEstimated: true, cropStage: 'flowering', season: 'monsoon' },
      { weightedShortfallIndex: null, droughtWeeks: null, durationIsEstimated: null, cropStage: null, season: null },
      'not-an-object',
      [1, 2, 3],
    ];
    for (const body of bad) {
      const res = await post('/api/calculate-payout', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const json = await res.json();
      assert.equal(typeof json.error, 'string');
      assert.equal(/stack|at Object|node_modules/.test(json.error), false);
    }
  });

  test('a JSON body over the 10kb cap is refused (§15.2)', async () => {
    const huge = JSON.stringify({
      weightedShortfallIndex: 50, droughtWeeks: 1, durationIsEstimated: true,
      cropStage: 'flowering', season: 'kharif', padding: 'x'.repeat(11 * 1024),
    });
    const res = await post('/api/calculate-payout', huge);
    assert.ok(res.status === 413 || res.status === 400, `got ${res.status}`);
  });
});

// ── §18.9 /api/recommendations ─────────────────────────────────────────────
describe('§18.9 GET /api/recommendations', () => {
  test('an unreachable log is 200 with available:false, not an error (§16.2)', async () => {
    const res = await get('/api/recommendations');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.entries, []);
    assert.equal(body.nextCursor, null);
    assert.equal(body.available, false);
    assert.equal(typeof body.reason, 'string');
  });

  test('parameter validation: district, date range, limit and cursor', async () => {
    assert.equal((await get('/api/recommendations?district=kolkata')).status, 400);
    assert.equal((await get('/api/recommendations?from=2026-10-08&to=2026-01-01')).status, 400);
    assert.equal((await get('/api/recommendations?from=08-10-2026')).status, 400);
    assert.equal((await get('/api/recommendations?district=jalna&limit=99999')).status, 200);
    assert.equal((await get('/api/recommendations?limit=abc')).status, 200);
    assert.equal((await get('/api/recommendations?cursor=not-a-cursor')).status, 200);
  });

  test('limit is clamped to the documented 50 default / 200 cap', () => {
    const { readLimit } = require('../middleware/validate');
    assert.equal(readLimit({ query: {} }), 50);
    assert.equal(readLimit({ query: { limit: '10' } }), 10);
    assert.equal(readLimit({ query: { limit: '999' } }), 200);
    assert.equal(readLimit({ query: { limit: '0' } }), 50);
    assert.equal(readLimit({ query: { limit: '-5' } }), 50);
    assert.equal(readLimit({ query: { limit: '1e9' } }), 200);
  });
});

// ── §18.6 /api/backtest/:district ─────────────────────────────────────────
describe('§18.6 GET /api/backtest/:district', () => {
  test('absent hindcast snapshot → 503 with a reason, never invented numbers', async () => {
    const res = await get('/api/backtest/jalna');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(typeof body.detail, 'string');
  });

  test('unknown district → 404, checked before the snapshot', async () => {
    assert.equal((await get('/api/backtest/nope')).status, 404);
  });
});

// ── cron §21.2 ────────────────────────────────────────────────────────────
describe('§21.2 cron entrypoint', () => {
  test('fails closed with no secret and rejects a wrong one', async () => {
    const wrong = await get('/api/cron/recommendations', { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const closed = await get('/api/cron/recommendations', { headers: { authorization: 'Bearer test-cron-secret' } });
      assert.equal(closed.status, 500);
      assert.match((await closed.json()).error, /CRON_SECRET/);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  test('runs the writer and reports honestly when the log cannot be written', async () => {
    const res = await get('/api/cron/recommendations', { headers: { authorization: 'Bearer test-cron-secret' } });
    // No SUPABASE_URL in a test run, so the audit trail is broken. The route must
    // say so rather than answer 200 over a log that recorded nothing (§17).
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.counts.districts, 4);
    assert.equal(body.logConfigured, false);
    assert.equal(body.logWritable, false);
    assert.equal(body.retention.days, 180);
    assert.equal(typeof body.runAt, 'string');
    for (const d of body.districts) assert.ok(DISTRICT_IDS.includes(d.district));
  });
});

// ── §18.5 /api/verify-receipt ─────────────────────────────────────────────
describe('§18.5 POST /api/verify-receipt', () => {
  test('is explicitly not implemented, and says where verification does live', async () => {
    const res = await post('/api/verify-receipt', { receiptId: 'x', canonicalInput: '{}' });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.error, 'Not implemented');
    assert.match(body.detail, /coreChecksum/);
  });
});

// ── §15.3 / §15.4 / §15.5 ─────────────────────────────────────────────────
describe('§15 transport, origins and throttling', () => {
  test('every response carries the §15.4 headers', async () => {
    const res = await get('/api/health');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /tile\.openstreetmap\.org/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('referrer-policy'), /strict-origin/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('an unlisted origin is rejected, a same-origin one is allowed (§15.3)', async () => {
    const evil = await get('/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const same = await get('/api/health', { headers: { origin: base } });
    assert.equal(same.status, 200);
    assert.equal(same.headers.get('access-control-allow-origin'), base);
    const dev = await get('/api/health', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(dev.status, 200);
  });

  test('a preflight from an allowed origin answers 204 with the CORS headers', async () => {
    const res = await fetch(`${base}/api/calculate-payout`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });

  test('rate-limit headers are published and the limiter eventually refuses (§15.5)', async () => {
    const first = await get('/api/health');
    assert.equal(first.headers.get('x-ratelimit-limit'), '120');
    assert.ok(Number(first.headers.get('x-ratelimit-remaining')) <= 119);

    const { LIMITS } = require('../middleware/rateLimit');
    let last = 0;
    for (let i = 0; i <= LIMITS.normal; i++) {
      last = (await get('/api/health')).status;
    }
    assert.equal(last, 429);
    // …and the refusal is a JSON error, not a stack trace
    const body = await (await get('/api/health')).json();
    assert.deepEqual(body, { error: 'Too many requests' });
  });

  test('unknown routes answer 404 as JSON', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found.' });
  });
});
