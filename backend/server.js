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
//   GET  /api/weather/:district?scenario=   §18.2 + F14 (historic replay)
//   GET  /api/scenarios                     F14   (committed catalogue)
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
const recommendationLog = require('./services/recommendationLog');
const hindcast = require('./services/hindcast');
const settlementLedger = require('./services/ledger');
const scenarioService = require('./services/scenario');
const memberRoster = require('./config/members');
const { loadCore, CORE_SPECIFIER } = require('./engines/phenology');
const { securityHeaders, corsAllowlist } = require('./middleware/security');
const { rateLimit } = require('./middleware/rateLimit');
const validate = require('./middleware/validate');

const CORE_PATH = path.resolve(__dirname, 'core', 'ks_core.mjs');
// `canonicalEncoding` is fixed by the core's canonicaliser (§10.2 F10); the
// literal is duplicated here only so the route can assert the served value.

const serveStatic = require('serve-static');

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

const CWSI_NOTE_LIVE = 'CWSI is derived from soil moisture — ERA5-Land reanalysis (0–7 cm) for historical points and a forecast model (3–9 cm) for the current point — not from satellite thermal-infrared canopy temperature.';

// §28.3 names the source of EVERY CWSI point, so a replay must say something
// different here: there is no forecast model with data for a date this old, and
// the current point is an archive daily mean. Leaving the live wording in place
// while publishing `era5_land_reanalysis` would make two of the product's own
// labels disagree with each other.
const CWSI_NOTE_SCENARIO = 'CWSI is derived from soil moisture — ERA5-Land reanalysis (0–7 cm) throughout this historic replay, including the current point, which is the archive daily mean on the anchor date (no forecast model has data for a date this old). It is not derived from satellite thermal-infrared canopy temperature.';

const SCENARIO_NOTE = 'Scenario replay (F14): precipitation and soil moisture are read from the Open-Meteo Archive API (ERA5-Land + archived daily precipitation) for the stated window, and the 30-year expectation comes from the same committed NASA POWER baseline as the live view. The scenario itself was SELECTED from the NASA POWER hindcast (F11) — a different reanalysis — so the tier computed here can differ from the tier recorded at selection time; both are labelled rather than reconciled (§28.8).';

const METHODOLOGY_NOTES = [
  'Drought duration is computed from archive data where available; when it is not, it is a model-derived estimate and the corresponding trigger clauses are disabled.',
  'Sum insured (₹50,000/ha) is a representative demo value; real PMFBY sums are crop- and district-specific via Scale of Finance.',
  CWSI_NOTE_LIVE,
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

/** §18.2 payload for one district. A replay swaps the CWSI note for the one that
 *  describes its actual sources and appends the F14 disclosure (§28). */
function methodologyNotes(scenario) {
  if (!scenario) return METHODOLOGY_NOTES;
  return METHODOLOGY_NOTES
    .map((note) => (note === CWSI_NOTE_LIVE ? CWSI_NOTE_SCENARIO : note))
    .concat(SCENARIO_NOTE);
}

/** §18.2 payload for one district. */
function weatherPayload(result, scenario = null) {
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
    // Derived from the canonical input, never restated: the receipt publishes
    // `currentSoilMoistureSource`, and a label that disagreed with the hashed one
    // would be the exact defect §19.3 exists to prevent.
    soilMoistureRawSource: engine && result.engineInput
      ? result.engineInput.currentSoilMoistureSource
      : null,
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
      : (scenario
        ? 'NASA POWER (30-yr baseline) + Open-Meteo Archive (ERA5-Land reanalysis + archived daily precipitation) — HISTORIC REPLAY'
        : 'NASA POWER (30-yr baseline) + Open-Meteo (ERA5-Land reanalysis + forecast model)'),
    dataQuality: result.dataQuality,
  };

  return {
    mode: scenario ? 'scenario' : 'live',
    scenario: scenarioBlock(scenario),
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
    methodologyNotes: methodologyNotes(scenario),
    attribution: ATTRIBUTION,
  };
}

// ── F14 scenario helpers ─────────────────────────────────────────────────────
// The label, the period and the "not current conditions" wording travel WITH the
// numbers (§10.2 F14, §19.6), so a replay can never be presented as live no
// matter which client reads the response.
function scenarioBlock(scenario) {
  if (!scenario) return null;
  return {
    id: scenario.id,
    label: scenario.label,
    districtId: scenario.districtId,
    season: scenario.season,
    year: scenario.year,
    anchorDate: scenario.anchorDate,
    period: scenario.period,
    // The exact archive range this replay reads: 56 days ending on the anchor.
    dataWindow: scenarioService.windowFor(scenario.anchorDate),
    trigger: scenario.trigger,
    selection: scenario.selection,
    isReplay: true,
    autoRefreshSuspended: true, // §19.5 — LIVE restores current conditions
    banner: `Historic replay — ${scenario.label}. Real archive data for ${scenario.period.from} to ${scenario.period.to}, not current conditions.`,
  };
}

// Validate `?scenario=` against the committed catalogue BEFORE anything is
// computed: an unknown id is a 404 and an id belonging to another district is a
// 400, so no request can make the engine read a window the catalogue never
// selected. The id is matched against the list — never interpolated into an
// outbound URL (§15.2).
function readScenario(req, res, districtId) {
  const raw = req.query.scenario;
  if (raw === undefined || raw === '') return { scenario: null };
  if (typeof raw !== 'string' || !scenarioService.SCENARIO_ID_RE.test(raw)) {
    res.status(400).json({ error: 'Invalid scenario.' });
    return { failed: true };
  }
  const scenario = scenarioService.getScenario(raw);
  if (!scenario) {
    res.status(404).json({ error: 'Scenario not found.' });
    return { failed: true };
  }
  if (districtId && scenario.districtId !== districtId) {
    res.status(400).json({ error: 'Scenario does not match the requested district.' });
    return { failed: true };
  }
  return { scenario };
}

function parseSeason(req, res) {
  const season = validate.readSeason(req);
  if (!season.ok) {
    res.status(400).json({ error: season.error });
    return null;
  }
  return season.season;
}

// ── One district, computed once ──────────────────────────────────────────────
// /api/weather and /api/cooperatives would otherwise each fan out to both external
// APIs for the same district in the same window. Degraded results are never cached
// (§16.2): caching "no data" would keep serving it after the source recovers.
async function computeDistrictCached(districtId, seasonParam, scenario = null) {
  // A scenario result is cached under ITS OWN key: mixing a historic replay and
  // a live reading under one key would serve each as the other (§10.2 F14).
  const cacheKey = `result:${districtId}:${seasonParam || 'auto'}:${scenario ? scenario.id : 'live'}`;
  const cached = cacheGet(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  const result = await computeDistrictWeather(districtId, {
    season: seasonParam,
    scenario: scenario || undefined,
  });
  recordSources(result.sources);
  if (!result.degraded) cacheSet(cacheKey, result);
  return result;
}

// ── Shared district computation ─────────────────────────────────────────────
// /api/districts and /api/ledger both need every district. Computing once and
// sharing keeps the ledger from doubling the fan-out to the external APIs (§23.2).
// A district whose computation is degraded is never cached: caching "no data"
// would keep serving it after the source recovers (§16.2).
async function computeAllDistricts(seasonParam) {
  const cacheKey = `all:${seasonParam || 'auto'}`;
  const cached = cacheGet(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  const results = await Promise.all(DISTRICT_IDS.map((id) =>
    computeDistrictWeather(id, { season: seasonParam })));
  for (const r of results) recordSources(r.sources);

  if (results.every((r) => !r.degraded)) cacheSet(cacheKey, results);
  return results;
}

// ── GET /api/districts (§18.1) ───────────────────────────────────────────────
app.get('/api/districts', rateLimit('expensive'), async (req, res, next) => {
  try {
    const seasonParam = parseSeason(req, res);
    if (seasonParam === null) return;
    const cacheKey = `districts:${seasonParam || 'auto'}`;
    const cached = cacheGet(cacheKey, 10 * 60 * 1000);
    if (cached) return res.json(cached);

    const results = await computeAllDistricts(seasonParam);

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

// ── GET /api/scenarios (F14) ───────────────────────────────────────────────
// The committed catalogue (backend/config/scenarios.json): data, not code, so
// the list can change without a release (§10.2 F14). Nothing here computes — a
// missing catalogue answers 503 with the command that generates it, the same
// honesty rule /api/backtest follows (§9.4, §16.2).
app.get('/api/scenarios', rateLimit('normal'), (req, res) => {
  const catalogue = scenarioService.readCatalogue();
  if (!catalogue) {
    return res.status(503).json({
      error: 'Not available',
      detail: 'The committed scenario catalogue (backend/config/scenarios.json, PRD §10.2 F14) has not been generated yet. Run: cd backend && node scripts/build-scenarios.js',
    });
  }
  return res.json({
    catalogue: {
      source: 'backend/config/scenarios.json',
      count: catalogue.scenarios.length,
      rule: catalogue.rule,
      derivedFrom: catalogue.derivedFrom,
      builtAt: catalogue.builtAt,
    },
    scenarios: catalogue.scenarios,
  });
});

// ── GET /api/weather/:district (§18.2) ───────────────────────────────────────
// With `?scenario=<id>` (F14) the same route replays one committed historic
// window instead of current conditions: the id is validated against the
// catalogue first, the engine reads that window's archived series, and the
// response carries the replay banner (§19.6) beside the very same §18.2 shape.
app.get('/api/weather/:district', rateLimit('expensive'), validate.requireDistrict, async (req, res, next) => {
  try {
    const seasonParam = parseSeason(req, res);
    if (seasonParam === null) return;

    const chosen = readScenario(req, res, req.district.id);
    if (chosen.failed) return;
    const scenario = chosen.scenario;
    if (scenario && seasonParam && seasonParam !== scenario.season) {
      return res.status(400).json({ error: 'Season conflicts with the scenario.' });
    }

    const cacheKey = `weather:${req.district.id}:${scenario ? scenario.id : (seasonParam || 'auto')}`;
    const cached = cacheGet(cacheKey, 10 * 60 * 1000);
    if (cached) return res.json(cached);

    const result = await computeDistrictCached(
      req.district.id,
      scenario ? scenario.season : seasonParam,
      scenario,
    );
    const payload = weatherPayload(result, scenario);

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

// ── GET/POST /api/cooperatives/:district (§18.7, F12) ────────────────────────
// The server holds NO member state: the roster is the committed file (§11.7) and a
// hectare edit arrives in the request and is gone when the response is sent (§16.3).
// That is the specified behaviour, not a gap to be patched — a per-instance store on
// a serverless runtime can lose an edit between two requests, not merely at restart.
// The response states it so the UI can state it wherever hectares are editable.
//
// memberPayout = hectares × tierPayoutPerHectare, 0 when the district is not
// triggering; cooperativeSum = Σ memberPayout (§10.2 F12).
async function buildCooperativePayload(district, seasonParam, overrides, scenario = null) {
  const core = await loadCore();
  const result = await computeDistrictCached(
    district.id,
    scenario ? scenario.season : seasonParam,
    scenario,
  );

  const roster = memberRoster.getMembers(district.id);
  const engine = result.engineOutput;
  const available = Boolean(engine);
  const payoutPerHectare = available ? engine.payoutPerHectare : 0;

  const rows = roster.map((m) => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, m.memberRef);
    const effective = overridden ? overrides[m.memberRef] : m.hectares;
    return {
      memberRef: m.memberRef,
      name: m.name,
      hectares: m.hectares,
      effectiveHectares: effective,
      overridden,
      memberPayout: available && engine.isTriggerMet
        ? Math.round(effective * payoutPerHectare)
        : 0,
    };
  });

  const totalHectares = Math.round(
    rows.reduce((sum, r) => sum + r.effectiveHectares, 0) * 100,
  ) / 100;
  const triggering = Boolean(available && engine.isTriggerMet);

  return {
    district: {
      id: district.id,
      name: district.name,
      state: district.state,
      zone: district.zone,
      agroZone: district.agroZone,
    },
    cooperative: memberRoster.getCooperative(district.id),
    date: result.seasonDate,
    season: result.season,
    cropStage: result.cropStage,
    // F14: the aggregation follows the active mode and is labelled with the
    // scenario, so a replayed cooperative total cannot read as a current one.
    mode: scenario ? 'scenario' : 'live',
    scenario: scenarioBlock(scenario),
    roster: {
      source: 'backend/config/members.js',
      memberCount: rows.length,
      // §F12's required wording, so the label cannot drift from the data it describes.
      label: `illustrative sample of ${rows.length} members`,
      illustrative: true,
      areasDeterministic: true,
    },
    persistence: {
      serverSide: false,
      note: 'changes are session-only — they reset when you reload (§16.3)',
    },
    assessment: {
      available,
      wsi: available ? engine.weightedShortfallIndex : null,
      severityLevel: available ? engine.severityLevel : null,
      payoutTier: available ? engine.payoutTier : null,
      tierLabel: available ? core.TIER_LABELS[engine.payoutTier] : null,
      payoutPerHectare: available ? engine.payoutPerHectare : null,
      percentSumInsured: available ? engine.percentSumInsured : null,
      isTriggerMet: triggering,
      durationIsEstimated: available ? engine.durationIsEstimated : null,
      dataQuality: result.dataQuality,
      receiptId: result.receipt ? result.receipt.receiptId : null,
      degradedReason: result.degradedReason,
    },
    aggregate: {
      memberCount: rows.length,
      totalHectares,
      triggeringMembers: triggering ? rows.length : 0,
      // null, not 0, when the assessment is unavailable: "we do not know" and "there
      // is no payout" are different claims and must not share a number (§16.2).
      cooperativeSum: available ? rows.reduce((sum, r) => sum + r.memberPayout, 0) : null,
      currency: 'INR',
    },
    members: rows,
    simulation: true,
  };
}

app.get('/api/cooperatives/:district', rateLimit('expensive'), validate.requireDistrict,
  async (req, res, next) => {
    try {
      const seasonParam = parseSeason(req, res);
      if (seasonParam === null) return;
      const chosen = readScenario(req, res, req.district.id);
      if (chosen.failed) return;
      if (chosen.scenario && seasonParam && seasonParam !== chosen.scenario.season) {
        return res.status(400).json({ error: 'Season conflicts with the scenario.' });
      }
      return res.json(await buildCooperativePayload(req.district, seasonParam, {}, chosen.scenario));
    } catch (err) {
      return next(err);
    }
  });

app.post('/api/cooperatives/:district', rateLimit('expensive'), validate.requireDistrict,
  async (req, res, next) => {
    try {
      const seasonParam = parseSeason(req, res);
      if (seasonParam === null) return;
      const chosen = readScenario(req, res, req.district.id);
      if (chosen.failed) return;
      if (chosen.scenario && seasonParam && seasonParam !== chosen.scenario.season) {
        return res.status(400).json({ error: 'Season conflicts with the scenario.' });
      }

      // A reference that is not in THIS district's roster would let a client append
      // phantom members and inflate the cooperative total (§15.2).
      const validRefs = new Set(
        memberRoster.getMembers(req.district.id).map((m) => m.memberRef),
      );
      const parsed = validate.validateHectareOverrides(req.body, validRefs);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const payload = await buildCooperativePayload(
        req.district, seasonParam, parsed.value, chosen.scenario,
      );
      payload.persistence.overrideCount = Object.keys(parsed.value).length;
      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  });

// ── GET /api/ledger (§18.4, F7) ──────────────────────────────────────────────
// Causal, deterministic, and drawn from the SINGLE owner of member identity
// (config/members.js): entries exist only for districts currently meeting a payout
// trigger, and each entry's tier and amount are that district's computed tier and
// amount. Timestamps are anchored to a fixed daily settlement time plus fixed
// per-entry offsets, so a reload is byte-identical (§F7). The ledger is display-only:
// no calculation may read it (§14.5).
//
// F7 requires the ledger to be LABELED (§19.2). The label travels as a header so the
// body stays exactly the bare LedgerEntry array §18.4 specifies, while any client
// reading this response still gets the disclosure.
app.get('/api/ledger', rateLimit('expensive'), async (req, res, next) => {
  try {
    const seasonParam = parseSeason(req, res);
    if (seasonParam === null) return;

    const chosen = readScenario(req, res);
    if (chosen.failed) return;

    // F14: in replay mode the ledger follows the active mode — it settles the ONE
    // district and window the scenario names, rather than mixing a historic
    // trigger with today's live districts. The labelling travels in the header,
    // so the body stays exactly the bare LedgerEntry array §18.4 specifies while
    // still stating which mode produced it.
    if (chosen.scenario) {
      const scenario = chosen.scenario;
      if (seasonParam && seasonParam !== scenario.season) {
        return res.status(400).json({ error: 'Season conflicts with the scenario.' });
      }
      const result = await computeDistrictCached(scenario.districtId, scenario.season, scenario);
      const entries = settlementLedger.buildLedger([result], { scenario });
      // Header values must be latin1-encodable, so the ASCII form states the
      // district, the exact period and the id — the label itself (with its em
      // dash) rides in the weather/cooperative bodies instead.
      res.setHeader('X-Ledger-Label',
        `Demo Settlement Log - Simulated, not real transactions - historic replay: `
        + `${scenario.districtName}, ${scenario.period.from} to ${scenario.period.to} (${scenario.id})`);
      if (entries.length === 0) {
        res.setHeader('X-Ledger-Note',
          `No payout trigger in the replayed window ${scenario.period.from} to ${scenario.period.to}.`);
      }
      return res.json(entries);
    }

    const results = await computeAllDistricts(seasonParam);
    const entries = settlementLedger.buildLedger(results);

    res.setHeader('X-Ledger-Label', 'Demo Settlement Log - Simulated, not real transactions');
    // §27: an empty ledger explains itself rather than looking broken.
    if (entries.length === 0) {
      res.setHeader('X-Ledger-Note', 'No district is currently meeting a payout trigger.');
    }
    return res.json(entries);
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/backtest/:district (§18.6) ─────────────────────────────────────
// Reads the committed build-time snapshot and computes nothing on the request
// path (§9.4). The snapshot does not exist until the F11 hindcast slice runs, so
// this answers honestly rather than inventing numbers.
app.get('/api/backtest/:district', rateLimit('normal'), validate.requireDistrict, (req, res) => {
  const summary = hindcast.getSummary(req.district.id);
  const snapshot = hindcast.readSnapshot();
  if (!summary || !snapshot) {
    return res.status(503).json({
      error: 'Not available',
      detail: 'The committed hindcast snapshot (backend/config/hindcast.json, PRD §9.4/F11) has not been generated yet. Run: cd backend && node scripts/run-hindcast.js',
    });
  }
  // §10.2 F11 requires the labelling to travel WITH the numbers: the source is a
  // different reanalysis than the live view, the soil leg is absent, and this is a
  // methodology check rather than a validation against claim outcomes (§28.8).
  return res.json({
    ...summary,
    period: snapshot.period,
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
    methodology: snapshot.methodology,
  });
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

// ── POST /api/verify-receipt (§18.5) ────────────────────────────────────────
// Server-side verification of a published receipt: hash the canonicalInput the
// client holds and compare it with the receiptId it also holds.
//
// This hashes the PUBLISHED CANONICAL STRING, which is exactly what §18.5's request
// shape provides. It uses Node's own SHA-256 rather than importing the core's
// test-only `_internals`, which §14.2 forbids on a product path — and the two are
// the same digest: §22.1 pins `ksReceipt(input).digest` against
// `crypto.createHash('sha256')` over the same canonical bytes (core.test.mjs). So
// this endpoint cannot disagree with a receipt the core produced, and the browser
// path (WebCrypto over the published string, checked against coreChecksum first)
// gives the identical answer.
app.post('/api/verify-receipt', rateLimit('normal'), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid body.' });
  }

  const { receiptId, canonicalInput } = body;
  if (typeof receiptId !== 'string' || !/^[0-9a-f]{64}$/.test(receiptId)) {
    return res.status(400).json({ error: 'Invalid receiptId.' });
  }
  if (typeof canonicalInput !== 'string' || canonicalInput.length === 0
    || canonicalInput.length > 8192) {
    return res.status(400).json({ error: 'Invalid canonicalInput.' });
  }

  const recomputedReceiptId = crypto.createHash('sha256')
    .update(canonicalInput, 'utf8')
    .digest('hex');

  // A mismatch is a RESULT, not a server error: the receipt is simply not the one
  // the canonical string produces.
  return res.json({
    match: recomputedReceiptId === receiptId,
    recomputedReceiptId,
  });
});

// ── GET /api/cron/recommendations (§21.2, F15) ─────────────────────────────
// The authenticated cron entrypoint declared in vercel.json. Vercel sends
// `Authorization: Bearer $CRON_SECRET`; with no secret configured it refuses
// rather than running unauthenticated (fail closed).
//
// The job itself lives in services/recommendationLog.js — this route is only the
// transport. It answers non-2xx when the log could not be written, because a
// scheduled run that silently records nothing is exactly the failure §17 warns
// about; the run is idempotent, so a platform retry is harmless.
app.get('/api/cron/recommendations', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  if (req.get('authorization') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const summary = await recommendationLog.runDailyJob();
    return res.status(summary.logWritable ? 200 : 503).json(summary);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[KrishiSat] cron failed: ${err.message}`);
    return res.status(500).json({ error: 'Job failed' });
  }
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

// ── Frontend (local dev + non-Vercel standalone run only) ──────────────────────
// In production on Vercel the platform serves frontend/dist and rewrites /api/*
// and /ks_core.mjs to this handler (§21.2), so this middleware is a convenience
// for running the API alone against an already-built frontend. It MUST NOT shadow
// any /api/* or /ks_core.mjs route.
{
  const frontendDist = path.resolve(__dirname, '../frontend/dist');
  const distExists = fs.existsSync(frontendDist) && fs.statSync(frontendDist).isDirectory();
  if (distExists) {
    // SPA fallback for any non-API, non-module path — serves index.html, not a
    // raw directory listing (§21.2 SPA fallback semantics).
    const serveFrontend = serveStatic(frontendDist, {
      index: ['index.html'],
      extensions: ['html'],
      fallthrough: false,
    });
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ks_core.mjs' || req.path.startsWith('/api/')) return next();
      serveFrontend(req, res, next);
    });
  }
}

// ── 404 + error handling ────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Generic client-facing message; internal detail stays in the server log (§15.9).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  // eslint-disable-next-line no-console
  console.error(`[KrishiSat] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`);
  if (res.headersSent) return;
  // A 4xx is the client's problem and may say so; only a 5xx gets the opaque
  // message. Either way the detail stays in the log (§15.9) — an earlier version
  // answered every failure with "Internal error.", which is both wrong for a 400
  // and useless to the caller.
  const message = status >= 500 ? 'Internal error.' : 'Invalid request.';
  res.status(status).json({ error: message });
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
