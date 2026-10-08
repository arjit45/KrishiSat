'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Deficit engine — PRD §10.1 F1–F4, §12.3, §12.4, §13.1, §23.3.
//
// Orchestration ONLY. Every index, threshold, tier, severity and canonical byte
// comes from backend/core/ks_core.mjs (§14.2). This file assembles the canonical
// engine input (§11.2) from the live sources, decides whether the drought duration
// is real or estimated (§12.3), and marks each source's quality (§11.8). It
// computes no index of its own and holds no payout math.
//
// §9.3 steps 3–8:
//   phenology (date + season → stage) → baselines (committed snapshot, §12.4) →
//   two independent sources in parallel (Forecast API: trailing precipitation +
//   current soil moisture; Archive API: ERA5-Land soil series for the trend and
//   the duration leg) → trailing-30 shortfall → soil deficit → CWSI + trend →
//   duration → tier/severity → receipt → aggregate quality.
//
// The clock is injected, never read inside the core (§14.3 rule 3).
// ─────────────────────────────────────────────────────────────────────────────

const { getDistrict, toPublicDistrict } = require('../config/districts');
const { loadCore, getCropStage, resolveSeason } = require('./phenology');
const climateCache = require('./climateCache');
const { fetchForecast, fetchArchiveSoil, forecastSoilMeanForDate, HISTORY_DAYS } = require('../services/openMeteo');

// §13.1: ERA5-Land updates daily with a ~5-day delay, so the duration soil leg is
// only "real" when the whole window it counts over is present (§12.3).
const DURATION_WINDOW_DAYS = 56;      // 8 weeks
const DROUGHT_WEEK_DAYS = 7;
const MAX_DURATION_WEEKS = 8;
const PRECIP_WEEK_FRACTION = 0.5;      // 7-day total below 50% of expectation
const SOIL_WEEK_FRACTION_OF_FC = 0.6;  // mean soil moisture below 60% of field capacity
const TREND_SAMPLE_OFFSETS = Object.freeze([28, 21, 14, 7, 0]); // 4 weekly points + today (F4)

const DATASOURCE_LIVE = 'NASA POWER (30-yr baseline) + Open-Meteo (ERA5-Land reanalysis + forecast model)';

// ── Calendar helpers (plain Date math; the ENGINE is not in the hash path) ───
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUTCDate(iso) {
  const m = ISO_RE.exec(String(iso));
  if (!m) throw new TypeError('date must be ISO yyyy-mm-dd');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function addDays(iso, days) {
  const d = toUTCDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The IST season-day (§11.9: the recommendation's own day, not the run time). */
function istToday(now) {
  const ms = (now instanceof Date ? now.getTime() : Date.now()) + 5.5 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);

/** Round to the canonical precision the receipt hashes at (§14.3 rule 2), so the
 *  numbers published in the response re-hash to the published digest exactly. */
function toCanonical(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
const mm3 = (v) => toCanonical(v, 3);          // mm → thousandths
const frac6 = (v) => toCanonical(v, 6);        // soil fractions → millionths

/**
 * §12.3 drought duration over an 8-week window, counted backwards from today.
 *
 * A drought week needs BOTH legs: its 7-day precipitation below 50% of that
 * window's climatological expectation AND its mean soil moisture below 60% of the
 * district's field capacity. The count resets when daily precipitation meets or
 * exceeds the daily expectation on two consecutive days.
 *
 * The count is REAL only when every day it relies on is present in both sources;
 * archive lag or a gap yields the §12.3 model estimate instead, and the caller
 * disables the tier OR-clauses for it (§10.1 F3).
 */
function evaluateDuration({ dates, precipByDate, soilByDate, expectedDaily, fieldCapacity }) {
  const windowDates = dates.slice(-DURATION_WINDOW_DAYS);
  const soilPresent = windowDates.filter((d) => soilByDate.has(d));
  const coverage = {
    windowDays: DURATION_WINDOW_DAYS,
    soilDaysPresent: soilPresent.length,
    precipDaysPresent: windowDates.filter((d) => precipByDate.has(d)).length,
    lastSoilDate: soilPresent.length ? soilPresent[soilPresent.length - 1] : null,
    lastForecastDate: windowDates.length ? windowDates[windowDates.length - 1] : null,
  };

  const todayStr = windowDates[windowDates.length - 1];
  if (!todayStr) {
    return { weeks: null, isEstimated: true, reason: 'no precipitation series available', coverage };
  }

  let weeks = 0;
  for (let k = 0; k < MAX_DURATION_WEEKS; k++) {
    const end = addDays(todayStr, -(k * DROUGHT_WEEK_DAYS));
    const week = [];
    for (let i = DROUGHT_WEEK_DAYS - 1; i >= 0; i--) week.push(addDays(end, -i));

    const complete = week.every((d) => precipByDate.has(d) && soilByDate.has(d));
    if (!complete) {
      return {
        weeks: null, // caller applies the §12.3 fallback
        isEstimated: true,
        reason: `drought-duration window not fully covered (${coverage.soilDaysPresent}/${coverage.windowDays} archive soil days, last ${coverage.lastSoilDate || 'none'})`,
        coverage,
      };
    }

    const precip7 = sum(week.map((d) => precipByDate.get(d)));
    const expected7 = sum(week.map((d) => expectedDaily(d)));
    const soil7 = mean(week.map((d) => soilByDate.get(d)));

    let reset = false;
    for (let i = 0; i < week.length - 1; i++) {
      if (precipByDate.get(week[i]) >= expectedDaily(week[i])
        && precipByDate.get(week[i + 1]) >= expectedDaily(week[i + 1])) {
        reset = true;
        break;
      }
    }
    if (reset) return { weeks, isEstimated: false, reason: 'precipitation reset', coverage };

    const isDroughtWeek = precip7 < PRECIP_WEEK_FRACTION * expected7
      && soil7 !== null && soil7 < SOIL_WEEK_FRACTION_OF_FC * fieldCapacity;
    if (!isDroughtWeek) return { weeks, isEstimated: false, reason: null, coverage };

    weeks += 1;
  }

  return { weeks, isEstimated: false, reason: null, coverage };
}

/**
 * §10.1 F4 — five CWSI points: four weekly ERA5-Land daily means plus the current
 * forecast-model value. Days missing from the archive (the normal 5-day lag) are
 * spliced from the Forecast API's own series and the affected dates are reported;
 * a point that can be sourced from neither is truncated and reported (§13.1).
 */
function buildCwsiTrend(core, { today, fieldCapacity, wiltingPoint, soilByDate,
  currentSoilMoisture, forecastHourlySoil }) {
  const points = [];
  const splicedDates = [];
  const truncatedDates = [];

  for (const offset of TREND_SAMPLE_OFFSETS) {
    const date = offset === 0 ? today : addDays(today, -offset);
    let value;
    let source;
    if (offset === 0) {
      value = currentSoilMoisture;
      source = 'forecast_model';
    } else if (soilByDate.has(date)) {
      value = soilByDate.get(date);
      source = 'era5_land_reanalysis';
    } else {
      const spliced = forecastSoilMeanForDate(forecastHourlySoil, date);
      if (spliced === null) {
        truncatedDates.push(date);
        continue;
      }
      value = spliced;
      source = 'era5_land_reanalysis_spliced_from_forecast_model';
      splicedDates.push(date);
    }
    points.push({ date, source, cwsi: core.ksCwsi(fieldCapacity, wiltingPoint, value) });
  }

  return { points, splicedDates, truncatedDates };
}

/**
 * §11.8 — LIVE when every source is LIVE, OFFLINE when none is, else PARTIAL.
 *
 * All three inputs count, including the committed NASA POWER baseline: §23.3's
 * "at least one source failed → PARTIAL" covers a §12.5 fallback baseline too. The
 * consequence is deliberate — with a committed snapshot present, two dead
 * Open-Meteo sources report PARTIAL, not OFFLINE, because part of what is shown
 * (the 30-year expectation) is still real data, and §19.3 reserves OFFLINE for
 * "all data from fallback". OFFLINE therefore means the snapshot is missing or
 * corrupt AND both live calls failed: the genuinely unrecoverable state.
 */
function aggregateQuality(qualities) {
  const values = Object.values(qualities);
  const live = values.filter((q) => q === 'LIVE').length;
  if (live === values.length) return 'LIVE';
  if (live === 0) return 'OFFLINE';
  return 'PARTIAL';
}

/**
 * Compute one district's recommendation.
 *
 * @param {string} districtId registry key (§11.1)
 * @param {{date?:string, season?:'kharif'|'rabi', now?:Date, scenarioId?:string|null,
 *   deps?:{fetchForecast?:Function, fetchArchiveSoil?:Function}}} [options]
 *   `deps` exists for §22.1 layer 7 (integration tests with mocked externals) and
 *   for nothing else; production callers pass nothing and get the real services.
 */
async function computeDistrictWeather(districtId, options = {}) {
  const district = getDistrict(districtId);
  if (!district) throw new RangeError(`unknown district "${districtId}"`);
  const deps = options.deps || {};
  const fetchForecastImpl = deps.fetchForecast || fetchForecast;
  const fetchArchiveSoilImpl = deps.fetchArchiveSoil || fetchArchiveSoil;

  const core = await loadCore();
  const today = options.date || istToday(options.now);
  const { season, seasonSource } = await resolveSeason(today, options.season);
  const cropStage = await getCropStage(district.id, today, season);
  const baselines = climateCache.getMonthBaselines(district.id, today);

  const expectedDaily = (date) =>
    core.ksDailyExpectedMm(date, baselines.monthlyMm[Number(date.slice(5, 7)) - 1]);

  // ── Sources: independent, parallel, each timed out and validated (§9.3, §15.6) ──
  const windowStart = addDays(today, -(HISTORY_DAYS - 1));
  const [forecastResult, archiveResult] = await Promise.allSettled([
    fetchForecastImpl({ lat: district.lat, lon: district.lon }),
    fetchArchiveSoilImpl({ lat: district.lat, lon: district.lon }, windowStart, today),
  ]);

  const forecast = forecastResult.status === 'fulfilled' ? forecastResult.value : null;
  const archive = archiveResult.status === 'fulfilled' ? archiveResult.value : null;
  const fallbackReasons = [];
  if (!forecast) fallbackReasons.push(`Open-Meteo forecast: ${forecastResult.reason.message}`);
  if (!archive) fallbackReasons.push(`Open-Meteo archive: ${archiveResult.reason.message}`);
  if (baselines.source === 'fallback') {
    fallbackReasons.push(`NASA POWER baseline: using ${baselines.sourceLabel}`);
  }

  const qualities = {
    openMeteoForecast: forecast ? 'LIVE' : 'FALLBACK',
    openMeteoArchive: archive ? 'LIVE' : 'FALLBACK',
    nasaPower: baselines.source === 'snapshot' ? 'LIVE' : 'FALLBACK',
  };
  const dataQuality = aggregateQuality(qualities);

  const base = {
    district: toPublicDistrict(district),
    season,
    seasonSource,
    cropStage: {
      label: cropStage.stageLabel,
      stageId: cropStage.stageId,
      multiplier: cropStage.multiplier,
      month: cropStage.monthName,
      isOffSeason: cropStage.isOffSeason,
    },
    baselineProvenance: {
      source: baselines.source,
      sourceLabel: baselines.sourceLabel,
      period: baselines.period,
      fetchedAt: baselines.fetchedAt,
      baselineMonthlyMm: baselines.baselineMonthlyMm,
      baselinePrevMonthMm: baselines.baselinePrevMonthMm,
    },
    sources: qualities,
    fallbackReasons,
    dataQuality,
    seasonDate: today,
    sourceLabels: {
      currentSoilMoisture: 'Open-Meteo forecast model (ICON/IFS), 3–9 cm',
      historicalSoilMoisture: 'ERA5-Land reanalysis (0–7 cm)',
    },
  };

  // ── Degraded path: no precipitation series ⇒ no shortfall is computable ──
  // The index is left NULL rather than filled with a substitute. Inventing an
  // observed total would fabricate exactly the kind of number F1 exists to remove,
  // and treating "no data" as zero rain would report a catastrophic drought during
  // an outage. §23.3: the dashboard still renders, marked OFFLINE/PARTIAL.
  if (!forecast) {
    return {
      ...base,
      degraded: true,
      degradedReason: 'precipitation source unavailable — no shortfall can be computed',
      engineInput: null,
      engineOutput: null,
      receipt: null,
      expected30Mm: mm3(core.ksExpected30Mm(today, baselines.baselineMonthlyMm, baselines.baselinePrevMonthMm)),
      actual30Mm: null,
      monthToDateMm: null,
      monthToDateExpectedMm: mm3(core.ksMonthToDateExpectedMm(today, baselines.baselineMonthlyMm)),
      soilMoistureRaw: null,
      cwsiTrend: [],
      cwsiTrendSpliced: [],
      cwsiTrendTruncated: [],
      durationCoverage: null,
      durationReason: null,
    };
  }

  // ── Precipitation window (§10.1 F1, §11.2) ──
  const dates = forecast.daily.map((d) => d.date);
  const precipByDate = new Map(forecast.daily.map((d) => [d.date, d.precipMm]));
  const trailing30 = forecast.daily.slice(-30);
  const actual30Mm = mm3(sum(trailing30.map((d) => d.precipMm)));
  const expected30Mm = mm3(core.ksExpected30Mm(today, baselines.baselineMonthlyMm, baselines.baselinePrevMonthMm));
  const monthToDateMm = mm3(sum(
    forecast.daily.filter((d) => d.date.slice(0, 7) === today.slice(0, 7)).map((d) => d.precipMm),
  ));
  const monthToDateExpectedMm = mm3(core.ksMonthToDateExpectedMm(today, baselines.baselineMonthlyMm));

  const soilByDate = new Map((archive ? archive.daily : [])
    .filter((d) => d.soilMoisture !== null)
    .map((d) => [d.date, d.soilMoisture]));

  // ── Duration (§12.3) ──
  const duration = evaluateDuration({
    dates, precipByDate, soilByDate, expectedDaily, fieldCapacity: district.fieldCapacity,
  });

  const engineInput = {
    districtId: district.id,
    season,
    date: today,
    scenarioId: options.scenarioId === undefined ? null : options.scenarioId,
    baselineMonthlyMm: mm3(baselines.baselineMonthlyMm),
    baselinePrevMonthMm: mm3(baselines.baselinePrevMonthMm),
    expected30Mm,
    actual30Mm,
    currentSoilMoisture: frac6(forecast.currentSoilMoisture),
    currentSoilMoistureSource: 'forecast_model',
    historicalSoilMoistureSource: 'era5_land_reanalysis',
    fieldCapacity: frac6(district.fieldCapacity),
    wiltingPoint: frac6(district.wiltingPoint),
    cropStageId: cropStage.stageId,
    cropStageMultiplier: toCanonical(cropStage.multiplier, 3),
    droughtWeeks: 0,
    durationIsEstimated: true,
  };

  // The §12.3 fallback duration is `min(8, floor(WSI / 12))`, and WSI does not
  // depend on duration — so one core call supplies the index and a second makes the
  // real decision. Both are the shipped core; no arithmetic is duplicated here.
  const probe = core.ksCompute(engineInput);
  const estimatedWeeks = Math.min(MAX_DURATION_WEEKS, Math.floor(probe.weightedShortfallIndex / 12));

  engineInput.droughtWeeks = duration.isEstimated ? estimatedWeeks : duration.weeks;
  engineInput.durationIsEstimated = duration.isEstimated;
  const engineOutput = core.ksCompute(engineInput);

  const trend = buildCwsiTrend(core, {
    today,
    fieldCapacity: district.fieldCapacity,
    wiltingPoint: district.wiltingPoint,
    soilByDate,
    currentSoilMoisture: engineInput.currentSoilMoisture,
    forecastHourlySoil: forecast.hourlySoil,
  });

  const receipt = core.ksReceipt(engineInput);

  return {
    ...base,
    degraded: false,
    degradedReason: null,
    engineInput,
    engineOutput,
    receipt: {
      receiptId: receipt.digest,
      algorithm: 'sha256',
      canonicalEncoding: 'scaled-int-v1',
      canonicalInput: receipt.canonicalString,
    },
    expected30Mm,
    actual30Mm,
    monthToDateMm,
    monthToDateExpectedMm,
    soilMoistureRaw: engineInput.currentSoilMoisture,
    cwsiTrend: trend.points.map((p) => p.cwsi),
    cwsiTrendPoints: trend.points,
    cwsiTrendSpliced: trend.splicedDates,
    cwsiTrendTruncated: trend.truncatedDates,
    durationCoverage: duration.coverage,
    durationReason: duration.reason,
  };
}

module.exports = {
  computeDistrictWeather,
  evaluateDuration,
  buildCwsiTrend,
  aggregateQuality,
  istToday,
  addDays,
  toCanonical,
  DATASOURCE_LIVE,
  DURATION_WINDOW_DAYS,
  MAX_DURATION_WEEKS,
};
