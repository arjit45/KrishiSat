'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Open-Meteo client — PRD §13.1, §10.1 F1/F4, §12.3.
//
// TWO endpoints, two variable families, never mixed (§13.1):
//
//   Forecast API  daily precipitation_sum  → the trailing precipitation window
//                 current soil_moisture_3_to_9cm → the CURRENT soil value
//                 hourly  soil_moisture_3_to_9cm → trend splice for recent days
//                 (forecast-model output: ICON / IFS / GFS)
//   Archive API   hourly soil_moisture_0_to_7cm → daily means for the trend's
//                 historical points and the drought-duration soil leg
//                 (ERA5-Land reanalysis)
//
// Both are asked in `Asia/Kolkata`, so a "day" is the IST day the §11.9 log
// records — one calendar date never means two different days inside the product.
//
// §15.6: every call has a timeout and capped retries, and a `200` carrying
// nulls/gaps is a DATA failure. These functions therefore throw; the engine
// catches per source and marks that source FALLBACK (§11.8).
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

const TIMEOUT_MS = 8000; // §15.6 "e.g. 8 s"
const MAX_ATTEMPTS = 2;  // one retry: a request path must not stall
const RETRY_BASE_MS = 400;

const TIMEZONE = 'Asia/Kolkata';

/** Days of history requested. §12.3 needs an 8-week (56-day) window to count
 *  drought weeks backwards; F1 uses the last 30 days of the same series. */
const HISTORY_DAYS = 56;

/** A day must have at least this many non-null hours to count as observed. */
const MIN_HOURS_PER_DAY = 12;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { data } = await axios.get(url, { timeout: TIMEOUT_MS });
      return data;
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
  const status = lastErr && lastErr.response ? ` (HTTP ${lastErr.response.status})` : '';
  throw new Error(`Open-Meteo request failed${status}: ${lastErr ? lastErr.message : 'unknown error'}`);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Forecast API: the trailing precipitation series, the current soil-moisture
 * value, and the forecast-model hourly series used to splice recent trend points.
 *
 * @param {{lat:number,lon:number}} point
 * @returns {Promise<{daily:{date:string,precipMm:number|null}[], currentSoilMoisture:number,
 *   currentSoilMoistureTime:string, currentPrecipMm:number,
 *   hourlySoil:{time:string,value:number|null}[]}>}
 */
async function fetchForecast(point) {
  const url = `${FORECAST_URL}?latitude=${point.lat}&longitude=${point.lon}`
    + '&current=precipitation,soil_moisture_3_to_9cm'
    + '&hourly=soil_moisture_3_to_9cm'
    + '&daily=precipitation_sum'
    + `&past_days=${HISTORY_DAYS}&forecast_days=1`
    + `&timezone=${encodeURIComponent(TIMEZONE)}`;
  const data = await getJson(url);

  const current = data.current;
  if (!current || !isNum(current.soil_moisture_3_to_9cm)) {
    throw new Error('Open-Meteo forecast: current soil_moisture_3_to_9cm missing');
  }

  const times = data.daily && data.daily.time;
  const sums = data.daily && data.daily.precipitation_sum;
  if (!Array.isArray(times) || !Array.isArray(sums) || times.length !== sums.length) {
    throw new Error('Open-Meteo forecast: daily precipitation series malformed');
  }
  const daily = times.map((date, i) => ({ date, precipMm: isNum(sums[i]) ? sums[i] : null }));

  // The trailing 30-day window is the index driver, so it must be complete: a
  // gap here is a data failure, not something to paper over with zeros (§15.6).
  const last30 = daily.slice(-30);
  const gaps = last30.filter((d) => d.precipMm === null).length;
  if (last30.length < 30 || gaps > 0) {
    throw new Error(`Open-Meteo forecast: trailing 30-day window incomplete (${last30.length} days, ${gaps} gaps)`);
  }

  const hourly = data.hourly && data.hourly.time;
  const hourlySoil = data.hourly && data.hourly.soil_moisture_3_to_9cm;
  const hourlySeries = Array.isArray(hourly) && Array.isArray(hourlySoil)
    ? hourly.map((time, i) => ({ time, value: isNum(hourlySoil[i]) ? hourlySoil[i] : null }))
    : [];

  return {
    daily,
    currentSoilMoisture: current.soil_moisture_3_to_9cm,
    currentSoilMoistureTime: current.time,
    currentPrecipMm: isNum(current.precipitation) ? current.precipitation : null,
    hourlySoil: hourlySeries,
  };
}

/**
 * Archive API: ERA5-Land soil moisture, hourly → daily means.
 *
 * Open-Meteo documents ERA5/ERA5-Land as updating daily with a ~5-day delay
 * (§13.1), so recent days are routinely absent. Absence is REPORTED (`missing`),
 * never filled with a zero or a previous value — the caller decides between
 * splicing (trend, marked) and marking the duration estimated (§12.3).
 *
 * @param {{lat:number,lon:number}} point
 * @param {string} startDate ISO yyyy-mm-dd
 * @param {string} endDate ISO yyyy-mm-dd
 * @returns {Promise<{daily:{date:string,soilMoisture:number|null}[], hoursPerDay:number}>}
 */
async function fetchArchiveSoil(point, startDate, endDate) {
  const url = `${ARCHIVE_URL}?latitude=${point.lat}&longitude=${point.lon}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + '&hourly=soil_moisture_0_to_7cm'
    + `&timezone=${encodeURIComponent(TIMEZONE)}`;
  const data = await getJson(url);
  return { daily: soilDailyMeans(data.hourly), hoursPerDay: 24 };
}

/**
 * Hourly ERA5-Land soil moisture → daily means, shared by both archive readers.
 * A day with fewer than `MIN_HOURS_PER_DAY` usable hours is `null` — reported as
 * a gap, never filled with a zero or a neighbouring value (§13.1, §15.6).
 *
 * @param {{time:string[], soil_moisture_0_to_7cm:(number|null)[]}} hourly
 * @returns {{date:string, soilMoisture:number|null}[]}
 */
function soilDailyMeans(hourly) {
  const times = hourly && hourly.time;
  const values = hourly && hourly.soil_moisture_0_to_7cm;
  if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length) {
    throw new Error('Open-Meteo archive: hourly soil_moisture_0_to_7cm malformed');
  }
  if (times.length === 0) throw new Error('Open-Meteo archive: empty response');

  /** @type {Map<string, number[]>} */
  const byDay = new Map();
  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10); // 'yyyy-mm-ddTHH:MM' in local (IST) time
    if (!isNum(values[i])) continue;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(values[i]);
  }

  const allDates = [...new Set(times.map((t) => t.slice(0, 10)))].sort();
  return allDates.map((date) => {
    const hours = byDay.get(date) || [];
    return {
      date,
      soilMoisture: hours.length >= MIN_HOURS_PER_DAY
        ? hours.reduce((a, b) => a + b, 0) / hours.length
        : null,
    };
  });
}

/**
 * Archive API in ONE call: daily precipitation totals AND the ERA5-Land soil
 * series for the same range. Used by the F14 scenario replay (§10.2 F14), which
 * reads a past window that the Forecast API cannot reach: `past_days` only goes
 * back a few months, while a replay reads a season from years ago.
 *
 * Same vendor, same discipline as the live path: a malformed or empty response
 * is a DATA failure and throws (§15.6); a `200` carrying nulls yields `null` days
 * rather than substituted numbers.
 *
 * @param {{lat:number,lon:number}} point
 * @param {string} startDate ISO yyyy-mm-dd
 * @param {string} endDate ISO yyyy-mm-dd
 * @returns {Promise<{from:string, to:string,
 *   precip:{date:string,precipMm:number|null}[],
 *   soil:{date:string,soilMoisture:number|null}[], hoursPerDay:number}>}
 */
async function fetchArchiveWindow(point, startDate, endDate) {
  const url = `${ARCHIVE_URL}?latitude=${point.lat}&longitude=${point.lon}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + '&daily=precipitation_sum&hourly=soil_moisture_0_to_7cm'
    + `&timezone=${encodeURIComponent(TIMEZONE)}`;
  const data = await getJson(url);

  const times = data.daily && data.daily.time;
  const sums = data.daily && data.daily.precipitation_sum;
  if (!Array.isArray(times) || !Array.isArray(sums) || times.length !== sums.length) {
    throw new Error('Open-Meteo archive: daily precipitation_sum series malformed');
  }
  if (times.length === 0) throw new Error('Open-Meteo archive: empty response');

  return {
    from: startDate,
    to: endDate,
    precip: times.map((date, i) => ({ date, precipMm: isNum(sums[i]) ? sums[i] : null })),
    soil: soilDailyMeans(data.hourly),
    hoursPerDay: 24,
  };
}

/** Mean of the forecast-model hourly series for one IST date, or null. */
function forecastSoilMeanForDate(hourlySoil, date) {
  const vals = hourlySoil.filter((h) => h.time.slice(0, 10) === date && h.value !== null)
    .map((h) => h.value);
  if (vals.length < MIN_HOURS_PER_DAY) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

module.exports = {
  fetchForecast,
  fetchArchiveSoil,
  fetchArchiveWindow,
  soilDailyMeans,
  forecastSoilMeanForDate,
  FORECAST_URL,
  ARCHIVE_URL,
  HISTORY_DAYS,
  TIMEZONE,
  TIMEOUT_MS,
  MAX_ATTEMPTS,
};
