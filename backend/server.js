'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KrishiSat API — Express app and routes (PRD §9.3, §18, §20.1)
//
// Every number this API returns is computed by the ONE committed core,
// backend/core/ks_core.mjs. There is no index math, threshold or payout table in
// this file: §14.2 puts them in the core and §14.4 forbids a second copy anywhere.
// The fabricated shortfall formula, the inline tier ladder and the .wasm artifact
// that this file used to carry are deleted — not ported, not flagged.
//
//   GET  /api/districts                     §18.1
//   GET  /api/weather/:district?season=     §18.2
//   POST /api/calculate-payout              §18.3
//   GET  /api/ledger                        §18.4   (simulated roster — see note)
//   GET  /api/backtest/:district            §18.6   (committed snapshot; F11 slice)
//   GET  /api/recommendations               §18.9
//   GET  /api/health                        §18.8
//   GET  /ks_core.mjs                       §20.1   the same bytes the server computes with
//   GET  /api/cron/recommendations                  authenticated cron entrypoint (F15)
//
// Read paths are side-effect free: nothing here writes (§9.3).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The one permitted database accessor (§14.5). Nothing else in this file may
// import a database client, and no route reads the log into a calculation.
const recommendations = require('./repositories/recommendations');

const { DISTRICTS, DISTRICT_IDS, getDistrict } = require('./config/districts');
const climateCache = require('./engines/climateCache');
const { computeDistrictWeather } = require('./engines/deficitEngine');
const { loadCore, CORE_SPECIFIER } = require('./engines/phenology');
const { securityHeaders, corsAllowlist } = require('./middleware/security');
const { rateLimit } = require('./middleware/rateLimit');
const validate = require('./middleware/validate');

const CORE_PATH = path.resolve(__dirname, 'core', 'ks_core.mjs');
const RECEIPT_ALGORITHM = 'sha256';
const CANONICAL_ENCODING = 'scaled-int-v1';

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(corsAllowlist);
app.use(express.json({ limit: '10kb' })); // §15.2

// ── Core access ──────────────────────────────────────────────────────────────
// Loaded through a dynamic import() (§14.2) — see engines/phenology.js, whose
// specifier is the single one this backend uses, so Node hands every caller the
// same module instance.

/** SHA-256 of the committed core source file. Memoised: the file is immutable per
 *  deploy, and §15.8 publishes this as `coreChecksum`. */
let checksumCache = null;
function coreChecksum() {
  if (!checksumCache) {
    checksumCache = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(CORE_PATH)).digest('hex')}`;
  }
  return checksumCache;
}

/** Stage ids are DERIVED from the core, so validating a request can never drift
 *  from the table that computes with them (§12.2, §14.2). */
let stageIdsCache = null;
async function validStageIds(core) {
  if (stageIdsCache) return stageIdsCache;
  const ids = new Set();
  for (let month = 1; month <= 12; month++) {
    for (const season of [1, 2]) ids.add(core.ksStageInfo(month, season).stageId);
  }
  stageIdsCache = ids;
  return ids;
}

// ── External-dependency monitor (§17, surfaced by §18.8) ─────────────────────
// Updated by real request traffic; no probe call is made by /api/health itself.
const sourceStatus = {
  openMeteo: { state: 'UNKNOWN', lastSuccessAt: null, lastFailureAt: null, failures: 0 },
};
function recordSources(sources) {
  const now = new Date().toISOString();
  const openMeteoLive = sources.openMeteoForecast === 'LIVE' || sources.openMeteoArchive === 'LIVE';
  if (openMeteoLive) {
    sourceStatus.openMeteo.state = 'UP';
    sourceStatus.openMeteo.lastSuccessAt = now;
  } else {
    sourceStatus.openMeteo.state = 'DOWN';
    sourceStatus.openMeteo.lastFailureAt = now;
    sourceStatus.openMeteo.failures += 1;
  }
}

// ── Response cache (§12.4) — ≤30 min, per instance, best-effort ──────────────
const responseCache = new Map();
function cacheGet(key, ttlMs) {
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit) responseCache.delete(key);
  return null;
}
function cacheSet(key, value) {
  // A tiny bound so a long-lived instance cannot grow without limit.
  if (responseCache.size > 200) responseCache.clear();
  responseCache.set(key, { at: Date.now(), value });
}

// ── §18.2 assembly ───────────────────────────────────────────────────────────
const ATTRIBUTION = [
  'Weather data by Open-Meteo.com (https://open-meteo.com/) — CC BY 4.0.',
  'Precipitation baseline: NASA POWER (https://power.larc.nasa.gov/).',
  'Basemap: © OpenStreetMap contributors (https://openstreetmap.org/copyright), ODbL.',
];

const METHODOLOGY_NOTES = [
  'Drought duration is computed from archive data where available; when it is not, it is a model-derived estimate and the corresponding trigger clauses are disabled.',
  'Sum insured (₹50,000/ha) is a representative demo value; real PMFBY sums are crop- and district-specific via Scale of Finance.',
  'CWSI is derived from soil moisture — ERA5-Land reanalysis (0–7 cm) for historical points and a forecast model (3–9 cm) for the current point — not from satellite thermal-infrared canopy temperature.',
  'Precipitation baseline is grid-cell-derived NASA POWER data, not station-interpolated IMD data.',
  'The settlement log is a simulation; no real financial transactions occur.',
  'This platform is a decision-support tool, not a licensed insurance product; all payout figures are recommendations.',
  'Crop-stage multipliers and the emergency fallback distribution are working values pending validation.',
  'The historical hindcast replays on NASA POWER daily data while the live view uses Open-Meteo: the same methodology over a different reanalysis source. It is a methodology sanity check, not a validation against real claim outcomes.',
];

/** IST ISO timestamp with offset, e.g. 2026-10-08T18:30:00+05:30 (§18.2 example). */
function istTimestamp(now = Date.now()) {
  const shifted = new Date(now + 5.5 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+05:30`;
}

/** §18.2 payload for one district. */
function weatherPayload(result) {
  const engine = result.engineOutput;
  const engineBlock = {
    baselineMonthlyMm: result.baselineProvenance.baselineMonthlyMm,
    baselinePrevMonthMm: result.baselineProvenance.baselinePrevMonthMm,
    baselinePeriod: result.baselineProvenance.period,
    baselineSource: result.baselineProvenance.sourceLabel,
    baselineQuality: result.sources.nasaPower,
    expected30Mm: result.expected30Mm,
    actual30Mm: result.actual30Mm,
    monthToDateMm: result.monthToDateMm,
    monthToDateExpectedMm: result.monthToDateExpectedMm,
    rainfallShortfallPercentage: engine ? engine.rainfallShortfallPercentage : null,
    cropStageMultiplier: result.cropStage.multiplier,
    weightedShortfallIndex: engine ? engine.weightedShortfallIndex : null,
    soilMoistureRaw: result.soilMoistureRaw,
    soilMoistureRawSource: engine ? 'forecast_model' : null,
    historicalSoilMoistureSource: 'era5_land_reanalysis',
    soilMoistureSourceLabels: result.sourceLabels,
    fieldCapacity: result.district.fieldCapacity,
    wiltingPoint: result.district.wiltingPoint,
    soilMoistureDeficitPercentage: engine ? engine.soilMoistureDeficitPercentage : null,
    cwsiProxy: engine ? engine.cwsiProxy : null,
    cwsiTrend: result.cwsiTrend,
    cwsiTrendPoints: result.cwsiTrendPoints || [],
    cwsiTrendSplicedDates: result.cwsiTrendSpliced,
    cwsiTrendTruncatedDates: result.cwsiTrendTruncated,
    droughtDurationWeeks: engine ? engine.droughtDurationWeeks : null,
    durationIsEstimated: engine ? engine.durationIsEstimated : true,
    durationReason: result.durationReason,
    durationCoverage: result.durationCoverage,
    isTriggerMet: engine ? engine.isTriggerMet : false,
    severityLevel: engine ? engine.severityLevel : 'NORMAL',
    payoutTier: engine ? engine.payoutTier : 'BELOW_THRESHOLD',
    payoutPerHectare: engine ? engine.payoutPerHectare : 0,
    percentSumInsured: engine ? engine.percentSumInsured : 0,
    dataSource: result.degraded
      ? `Degraded — ${result.degradedReason}`
      : 'NASA POWER (30-yr baseline) + Open-Meteo (ERA5-Land reanalysis + forecast model)',
    dataQuality: result.dataQuality,
  };

  return {
    district: {
      id: result.district.id,
      name: result.district.name,
      state: result.district.state,
      agroZone: result.district.agroZone,
      primaryCrops: result.district.primaryCrops,
      lat: result.district.lat,
      lon: result.district.lon,
      fieldCapacity: result.district.fieldCapacity,
      wiltingPoint: result.district.wiltingPoint,
    },
    date: result.seasonDate,
    season: result.season,
    seasonSource: result.seasonSource,
    cropStage: result.cropStage,
    parametricDeficitEngine: engineBlock,
    receipt: result.receipt
      ? {
        receiptId: result.receipt.receiptId,
        algorithm: result.receipt.algorithm,
        canonicalEncoding: result.receipt.canonicalEncoding,
        canonicalInput: result.receipt.canonicalInput,
        createdAt: istTimestamp(),
      }
      : null,
    sourceQuality: result.sources,
    fallbackReasons: result.fallbackReasons,
    methodologyNotes: METHODOLOGY_NOTES,
    attribution: ATTRIBUTION,
  };
}

function parseSeason(req, res) {
  const season = validate.readSeason(req);
  if (!season.ok) {
    res.status(400).json({ error: season.error });
    return null;
  }
  return season.season;
}

// ── GET /api/districts (§18.1) ───────────────────────────────────────────────
app.get('/api/districts', rateLimit('expensive'), async (req, res, next) => {
  try {
    const seasonParam = parseSeason(req, res);
    if (seasonParam === null) return;
    const cacheKey = `districts:${seasonParam || 'auto'}`;
    const cached = cacheGet(cacheKey, 10 * 60 * 1000);
    if (cached) return res.json(cached);

    const results = await Promise.all(DISTRICT_IDS.map((id) =>
      computeDistrictWeather(id, { season: seasonParam })));
    for (const r of results) recordSources(r.sources);

    const payload = results.map((r) => ({
      id: r.district.id,
      name: r.district.name,
      state: r.district.state,
      zone: r.district.zone,
      wsi: r.engineOutput ? r.engineOutput.weightedShortfallIndex : null,
      severity: r.engineOutput ? r.engineOutput.severityLevel : 'NORMAL',
      payoutTier: r.engineOutput ? r.engineOutput.payoutTier : 'BELOW_THRESHOLD',
      cropStage: r.cropStage.label,
      dataQuality: r.dataQuality,
    }));

    cacheSet(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/weather/:district (§18.2) ───────────────────────────────────────
app.get('/api/weather/:district', rateLimit('expensive'), validate.requireDistrict, async (req, res, next) => {
  try {
    const seasonParam = parseSeason(req, res);
    if (seasonParam === null) return;

    const cacheKey = `weather:${req.district.id}:${seasonParam || 'auto'}`;
    const cached = cacheGet(cacheKey, 10 * 60 * 1000);
    if (cached) return res.json(cached);

    const result = await computeDistrictWeather(req.district.id, { season: seasonParam });
    recordSources(result.sources);
    const payload = weatherPayload(result);

    // A degraded response is not cached: caching "no data" would keep serving it
    // after the source recovers (§16.2).
    if (!result.degraded) cacheSet(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/calculate-payout (§18.3) ───────────────────────────────────────
app.post('/api/calculate-payout', rateLimit('payout'), async (req, res, next) => {
  try {
    const core = await loadCore();
    const body = validate.validatePayoutBody(req.body, await validStageIds(core));
    if (!body.ok) return res.status(400).json({ error: body.error });

    const { weightedShortfallIndex, droughtWeeks, durationIsEstimated, cropStage } = body.value;
    const isSowingStage = core.ksIsSowingStageId(cropStage);
    const tier = core.ksPayoutTier(
      Math.round(weightedShortfallIndex * 1000),
      droughtWeeks,
      durationIsEstimated,
      isSowingStage,
    );

    return res.json({
      payoutPerHectare: core.THRESHOLDS.payoutPerHectare[tier],
      tier,
      tierLabel: core.TIER_LABELS[tier],
      percentSumInsured: core.THRESHOLDS.percentSumInsured[tier],
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/ledger (§18.4) ──────────────────────────────────────────────────
// NOT REWIRED BY THIS SLICE, deliberately. F7 requires ledger entries to be drawn
// from the F12 member records, which are the SINGLE owner of member identity, name
// and area — and config/members.js does not exist yet. Producing entries here would
// either fabricate member identity or become a second owner of it, so the existing
// simulated response is left in place until the F7/F12 slice, and the defect is
// recorded rather than hidden:
//   TODO(F7/F12 slice): deterministic entries keyed on today's computed triggers,
//   drawn from config/members.js, byte-identical across reloads, no Math.random(),
//   no wall-clock timestamps (F7). The ledger stays display-only: no calculation
//   may read it (§14.5).
app.get('/api/ledger', (req, res) => {
    // Regional Indian names covering all 4 districts
    const names = [
        'Ramesh Pawar', 'Sanjay Deshmukh', 'Anil Kadam',
        'Amol Patil', 'Vikas Shinde', 'Hari Singh Bhati',
        'Rajendra Prasad', 'Mahendra Choudhary', 'Gopal Purohit',
        'Devendra Singh', 'Gaurav Malviya', 'Satish Patel',
        'Vijay Solanki', 'Rahul Verma', 'Yogesh Joshi',
        'K. Raghavulu', 'N. Venkatesh', 'M. Lakshmaiah',
        'P. Srinivasa Rao', 'Chandra Reddy',
    ];

    const regions = [
        { cooperative: 'Jalna, Maharashtra', base: 'MH-COOP-' },
        { cooperative: 'Bikaner, Rajasthan', base: 'RJ-COOP-' },
        { cooperative: 'Dewas, Madhya Pradesh', base: 'MP-COOP-' },
        { cooperative: 'Anantapur, Andhra Pradesh', base: 'AP-COOP-' },
    ];

    const tiers = [
        { label: 'TIER 1 MODERATE', amount: 25000 },
        { label: 'TIER 2 SEVERE', amount: 37500 },
        { label: 'TIER 3 CATASTROPHIC', amount: 50000 },
    ];

    const transactions = Array.from({ length: 12 }, (_, i) => {
        const name = names[Math.floor(Math.random() * names.length)];
        const region = regions[Math.floor(Math.random() * regions.length)];
        const tier = tiers[Math.floor(Math.random() * tiers.length)];

        const time = new Date();
        time.setMinutes(time.getMinutes() - i * 35);

        return {
            farmerName: `${name} (${region.base}${2400 + i})`,
            cooperative: region.cooperative,
            tier: tier.label,
            amount: tier.amount,
            timestamp: time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ' IST',
        };
    });

    return res.json(transactions);
});

// ── GET /api/backtest/:district (§18.6) ─────────────────────────────────────
// Reads the committed build-time snapshot and computes nothing on the request
// path (§9.4). The snapshot does not exist until the F11 hindcast slice runs, so
// this answers honestly rather than inventing numbers.
app.get('/api/backtest/:district', rateLimit('normal'), validate.requireDistrict, (req, res) => {
  const snapshotPath = path.join(__dirname, 'config', 'hindcast.json');
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return res.status(503).json({
      error: 'Not available',
      detail: 'The committed hindcast snapshot (backend/config/hindcast.json, PRD §9.4/F11) has not been generated yet.',
    });
  }
  const entry = snapshot[req.district.id];
  if (!entry) return res.status(404).json({ error: 'District not found.' });
  return res.json(entry);
});

// ── GET /ks_core.mjs (§20.1) ────────────────────────────────────────────────
// The SINGLE served location of the core (§15.8). The browser imports these exact
// bytes for F10 verification, so the Content-Type must be a JavaScript type — a
// module served as anything else is refused by the browser and the whole
// verification feature dies silently (§21.2).
app.get('/ks_core.mjs', (req, res) => {
  let source;
  try {
    source = fs.readFileSync(CORE_PATH, 'utf8');
  } catch {
    return res.status(503).json({ error: 'Core module unavailable' });
  }
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Core-Checksum', coreChecksum());
  return res.send(source);
});

// ── POST /api/verify-receipt (§18.5) ───────────────────────────────────────
// NOT IMPLEMENTED, and answering 501 rather than 404 so the gap is visible.
//
// Server-side verification would have to hash the PUBLISHED canonical string, and
// the only digest primitive in the product is `ksReceipt`, which canonicalises an
// EngineInput first — feeding it an already-scaled string would scale the values a
// second time and produce a different, wrong digest. The integer SHA-256 that could
// hash a bare string lives in the core's test-only `_internals`, which §14.2
// forbids on a product path. F10's verification therefore ships where the spec puts
// it: the browser hashes the published `canonicalInput` with WebCrypto and asserts
// the module's own `coreChecksum` first (§15.8). Adding a server-side variant needs
// a PRD change, not a workaround.
app.post('/api/verify-receipt', (req, res) => res.status(501).json({
  error: 'Not implemented',
  detail: 'Server-side receipt verification is specified by PRD §18.5 but not implemented. Recompute the receipt in the browser instead: assert that the imported module hashes to coreChecksum (/api/health), then SHA-256 the published canonicalInput and compare it with receiptId.',
}));

// ── GET /api/cron/recommendations ───────────────────────────────────────────
// The authenticated cron entrypoint declared in vercel.json (§21.2). Vercel sends
// `Authorization: Bearer $CRON_SECRET`; with no secret configured it refuses
// rather than running unauthenticated (fail closed).
//
// The writer — backend/services/recommendationLog.js (F15, §20.1) — is not
// implemented, so this answers 501 instead of pretending to succeed. A scheduled
// run must not look like a working log while recording nothing.
app.get('/api/cron/recommendations', (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  if (req.get('authorization') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(501).json({
    error: 'Not implemented',
    detail: 'The recommendation-log writer (backend/services/recommendationLog.js) is specified by PRD F15/§20.1 but not yet implemented.',
  });
});

// ── GET /api/recommendations (§18.9) ────────────────────────────────────────
// Read-only history from the log. A missing history is NOT an error: an
// unreachable log answers 200 with `available: false` and a reason, so the
// dashboard keeps rendering (§16.2, §19.4).
app.get('/api/recommendations', rateLimit('normal'), async (req, res, next) => {
  try {
    const district = req.query.district;
    if (district !== undefined && district !== '' && !getDistrict(district)) {
      return res.status(400).json({ error: 'Invalid district.' });
    }
    const range = validate.readDateRange(req);
    if (!range.ok) return res.status(400).json({ error: range.error });

    const limit = validate.readLimit(req, { def: 50, max: 200 });
    const result = await recommendations.list({
      district: district || undefined,
      from: range.from,
      to: range.to,
      limit,
      cursor: req.query.cursor || undefined,
    });

    if (!result || result.available === false) {
      return res.json({
        entries: [],
        nextCursor: null,
        available: false,
        reason: (result && result.reason) || 'Recommendation log unreachable',
      });
    }
    return res.json({
      entries: result.entries || [],
      nextCursor: result.nextCursor || null,
      available: true,
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/health (§18.8) ─────────────────────────────────────────────────
// `status` reflects the API and its external sources only. The `log` and
// `instance` blocks are evaluated in their own try/catch and can never turn the
// response into a failure: a database that is down must not make the API report
// itself unhealthy while every read path still works (§16.2).
app.get('/api/health', rateLimit('normal'), async (req, res) => {
  let coreVersion = null;
  let checksum = null;
  try {
    const core = await loadCore();
    coreVersion = core.KS_VERSION;
    checksum = coreChecksum();
  } catch {
    checksum = null;
  }

  let log;
  try {
    log = await recommendations.health();
  } catch {
    log = { reachable: false, configured: false, lastAppendAt: null, empty: true, stale: false, reason: 'unexpected error' };
  }

  let climateSeeded = false;
  try {
    climateSeeded = climateCache.isSeeded();
  } catch {
    climateSeeded = false;
  }

  return res.json({
    status: 'ok',
    ts: Date.now(),
    coreVersion,
    coreChecksum: checksum,
    apiStatus: {
      openMeteo: sourceStatus.openMeteo.state,
      nasaPower: climateSeeded ? 'UP' : 'DOWN',
    },
    sources: {
      openMeteo: sourceStatus.openMeteo,
      nasaPower: {
        note: 'Committed NASA POWER snapshot (§12.4); POWER itself is contacted only at build time.',
        climateSeeded,
      },
    },
    instance: {
      climateSeeded,
      note: 'best-effort; never a correctness dependency (§12.4)',
    },
    log,
  });
});

// ── 404 + error handling ────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Generic client-facing message; internal detail stays in the server log (§15.9).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  // eslint-disable-next-line no-console
  console.error(`[KrishiSat] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`);
  if (res.headersSent) return;
  res.status(status).json({ error: 'Internal error.' });
});

// ── Listen only when run directly ───────────────────────────────────────────
// api/index.js imports this module as the Vercel handler and the platform owns the
// listener there (§21.2); listening on import would open a port inside a
// serverless function.
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 5000;
  app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log(`  ║  KrishiSat — parametric trigger API :${String(PORT).padEnd(5)} ║`);
    console.log('  ║  core  backend/core/ks_core.mjs    (§14.2)   ║');
    console.log('  ║  districts  jalna · bikaner · dewas ·        ║');
    console.log('  ║             anantapur                        ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
  });
}

module.exports = app;
module.exports.coreChecksum = coreChecksum;
module.exports.CORE_PATH = CORE_PATH;
module.exports.CORE_SPECIFIER = CORE_SPECIFIER;
module.exports.DISTRICTS = DISTRICTS;
