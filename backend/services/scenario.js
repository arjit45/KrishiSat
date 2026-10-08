'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Scenario / Replay Mode — PRD §10.2 F14, §19.5, §19.6.
//
// Two halves, deliberately separate:
//
//   1. THE CATALOGUE (data, not code). config/scenarios.json is committed by
//      scripts/build-scenarios.js from the F11 hindcast. This module only reads
//      it. `GET /api/scenarios` and the `?scenario=` selector never compute
//      anything — a list that could change without a release is the point of
//      storing it as data (§10.2 F14).
//
//   2. THE REPLAY DATA PATH. A replay evaluates one past day, so it cannot use
//      the Forecast API: `past_days` reaches a few months, not a season years
//      ago. It reads the SAME vendor's Archive API (Open-Meteo, ERA5-Land +
//      archived daily precipitation) over the window ending on the anchor date —
//      the same source family the live path already uses for its soil leg — and
//      hands the engine exactly the two `deps` functions it already takes in the
//      live path. Synthetic or hand-tuned inputs are not permitted anywhere in a
//      scenario (§10.2 F14), so there is no code path that invents a value here:
//      a gap in the archive is a throw, and the engine degrades like it always
//      does.
//
// Nothing in this module runs on a clock or a request path by itself: the window
// arithmetic is pure, the fetch is single-flight and cached per window, and the
// catalogue is re-read from disk on demand (it is a few kilobytes).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { fetchArchiveWindow, HISTORY_DAYS } = require('./openMeteo');

const CATALOGUE_PATH = path.join(__dirname, '..', 'config', 'scenarios.json');

const DAY_MS = 86_400_000;

/** The id form §10.2 F14 fixes: `<district>-<season>-<year>`. */
const SCENARIO_ID_RE = /^[a-z]+-(kharif|rabi)-\d{4}$/;

// ── Catalogue ───────────────────────────────────────────────────────────────

/**
 * Read the committed catalogue. Returns `null` when it is missing or malformed,
 * so callers answer 503 with instructions instead of inventing a list (§16.2).
 * Read fresh every time: a rebuild is picked up without a restart, and the file
 * is a few kilobytes.
 */
function readCatalogue() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) return null;
  if (!parsed.scenarios.every(isValidEntry)) return null;
  return parsed;
}

function isValidEntry(s) {
  return Boolean(s)
    && typeof s.id === 'string' && SCENARIO_ID_RE.test(s.id)
    && typeof s.districtId === 'string'
    && typeof s.season === 'string' && (s.season === 'kharif' || s.season === 'rabi')
    && typeof s.year === 'number'
    && typeof s.anchorDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.anchorDate)
    && typeof s.label === 'string'
    && s.period && typeof s.period.from === 'string' && typeof s.period.to === 'string'
    && typeof s.trigger === 'boolean';
}

function isAvailable() {
  return readCatalogue() !== null;
}

/** Every scenario in the committed list, in catalogue order. */
function listScenarios() {
  const catalogue = readCatalogue();
  return catalogue ? catalogue.scenarios : [];
}

/** One scenario by id, or null. Length-bounded: this is user input. */
function getScenario(id) {
  if (typeof id !== 'string' || id.length > 64) return null;
  return listScenarios().find((s) => s.id === id) || null;
}

// ── Replay window ───────────────────────────────────────────────────────────

/**
 * The archive range a replay reads: `HISTORY_DAYS` (56) days ending on the
 * anchor date — the §12.3 8-week duration window, whose first 30 days are also
 * the §10.1 F1 trailing index window.
 *
 * @param {string} anchorDate ISO yyyy-mm-dd
 * @returns {{from:string, to:string}}
 */
function windowFor(anchorDate) {
  const t = Date.parse(`${anchorDate}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new TypeError(`anchorDate is not ISO yyyy-mm-dd: ${anchorDate}`);
  const from = new Date(t - (HISTORY_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to: anchorDate };
}

/**
 * Shape an archived window into exactly what the engine's forecast-slot dep
 * returns, so the live assembly code runs UNCHANGED over a historic window
 * (§10.2 F14: "the identical engine … over the archived daily series").
 *
 * Validation mirrors `fetchForecast`: the trailing 30-day window drives the
 * index, so a gap in it is a data FAILURE, not something to paper over with
 * zeros — and the "current" soil value for a past day is the ERA5-Land daily
 * mean on the anchor date, which must exist. `hourlySoil` is empty because no
 * forecast-model series exists for a historic date; the trend's historical
 * points come from the archive series the engine already holds.
 *
 * @param {{from:string,to:string,precip:{date:string,precipMm:number|null}[],
 *   soil:{date:string,soilMoisture:number|null}[]}} window
 * @param {string} anchorDate
 */
function forecastFromWindow(window, anchorDate) {
  const precip = window && window.precip;
  if (!Array.isArray(precip) || precip.length === 0) {
    throw new Error(`scenario archive: no precipitation series for ${anchorDate}`);
  }

  const last30 = precip.slice(-30);
  const gaps = last30.filter((d) => d.precipMm === null).length;
  if (last30.length < 30 || gaps > 0) {
    throw new Error(`scenario archive: trailing 30-day window incomplete (${last30.length} days, ${gaps} gaps)`);
  }

  const soilAtAnchor = (window.soil || []).find((d) => d.date === anchorDate);
  if (!soilAtAnchor || soilAtAnchor.soilMoisture === null) {
    throw new Error(`scenario archive: no soil moisture on the anchor date ${anchorDate} (ERA5-Land daily mean)`);
  }

  const onAnchor = precip.find((d) => d.date === anchorDate);
  return {
    daily: precip,
    currentSoilMoisture: soilAtAnchor.soilMoisture,
    currentSoilMoistureTime: `${anchorDate} (ERA5-Land daily mean, 0–7 cm)`,
    currentPrecipMm: onAnchor ? onAnchor.precipMm : null,
    hourlySoil: [],
  };
}

// ── Archive window fetch (single-flight, per window) ────────────────────────
// One Archive API call serves BOTH deps for a window. The map holds promises, so
// a burst of scenario traffic makes one outbound request rather than one per
// caller (§23.2 bounds fan-out), and a rejected fetch is evicted immediately —
// caching "no data" would keep serving it after the source recovers (§16.2).

const WINDOW_TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, {at:number, promise:Promise<any>}>} */
const windowCache = new Map();

function archiveWindow(point, from, to) {
  const key = `${point.lat},${point.lon},${from},${to}`;
  const now = Date.now();
  for (const [k, v] of windowCache) {
    if (now - v.at > WINDOW_TTL_MS) windowCache.delete(k);
  }
  const hit = windowCache.get(key);
  if (hit && now - hit.at <= WINDOW_TTL_MS) return hit.promise;

  const promise = fetchArchiveWindow(point, from, to);
  windowCache.set(key, { at: now, promise });
  promise.catch(() => windowCache.delete(key));
  return promise;
}

/**
 * The two `deps` the engine already accepts, backed by one archived window.
 *
 * @param {{anchorDate:string}} scenario
 * @param {{lat:number,lon:number}} district
 * @returns {{fetchForecast:Function, fetchArchiveSoil:Function}}
 */
function depsFor(scenario, district) {
  const { from, to } = windowFor(scenario.anchorDate);
  const point = { lat: district.lat, lon: district.lon };

  return {
    // Forecast slot: the archived daily series + the anchor day's soil value.
    fetchForecast: async () => forecastFromWindow(await archiveWindow(point, from, to), scenario.anchorDate),
    // Archive slot: the same window's ERA5-Land daily means.
    fetchArchiveSoil: async () => {
      const window = await archiveWindow(point, from, to);
      return { daily: window.soil, hoursPerDay: window.hoursPerDay };
    },
  };
}

module.exports = {
  CATALOGUE_PATH,
  SCENARIO_ID_RE,
  readCatalogue,
  listScenarios,
  getScenario,
  isAvailable,
  windowFor,
  forecastFromWindow,
  depsFor,
};
