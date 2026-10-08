'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// NASA POWER client — PRD §13.2.
//
// Build-time only: this module is used by scripts/fetch-baseline.js (the committed
// climatology snapshot, §12.4) and, later, by the hindcast job (§10.2 F11). It is
// NOT on any request path, because POWER warns that repeated requests for the same
// point may be blocked (§13.2 "Request hygiene") — the snapshot exists so no
// request ever waits on it.
//
// Populated from the base snapshot on use: every call is bounded by a timeout and
// a capped number of retries (§15.6), and a `200` carrying null/gap values is a
// DATA failure, not a success.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

const CLIMATOLOGY_URL = 'https://power.larc.nasa.gov/api/temporal/climatology/point';
const DAILY_URL = 'https://power.larc.nasa.gov/api/temporal/daily/point';

const TIMEOUT_MS = 20000; // build-time only, so more generous than the 8 s request budget
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 750;
const FILL_VALUE = -999;

const MONTH_KEYS = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL',
  'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

/** Days in a non-leap month — the convention for turning a climatological mm/day
 *  into a monthly total (§13.2 "the value × days in the month"). Documented in the
 *  committed snapshot so the conversion is never a hidden assumption. */
const DAYS_IN_MONTH_NON_LEAP = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with a hard timeout and capped retries. Retries only transport failures and
 * 5xx/429 — a 4xx is a contract error and is not retried.
 * @param {string} url
 * @returns {Promise<any>}
 */
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
  throw new Error(`NASA POWER request failed${status}: ${lastErr ? lastErr.message : 'unknown error'}`);
}

/**
 * Monthly precipitation climatology for one point, in mm per calendar month.
 *
 * The period is NEVER left to the API default: `start`/`end` are explicit (§13.2)
 * and returned to the caller so the snapshot can record exactly what was asked
 * for. `time-standard=UTC` is passed so POWER does not fall back to Local Solar
 * Time; the standard POWER actually reports is returned alongside the values.
 *
 * @param {{lat:number,lon:number}} point
 * @param {{start:number,end:number}} period e.g. {start:1991,end:2020}
 * @returns {Promise<{monthlyMm:number[], mmPerDay:number[], annualMm:number,
 *   monsoonMm:number, period:string, timeStandard:string, apiVersion:string}>}
 */
async function fetchClimatology(point, period) {
  const { start, end } = period;
  const url = `${CLIMATOLOGY_URL}?parameters=PRECTOTCORR&community=AG`
    + `&longitude=${point.lon}&latitude=${point.lat}`
    + `&start=${start}&end=${end}&format=JSON&time-standard=UTC`;
  const data = await getJson(url);

  if (data.header && data.header.fill_value !== undefined
    && data.header.fill_value !== FILL_VALUE) {
    // Recorded, not enforced: we only need to know how POWER marks "no data".
    // eslint-disable-next-line no-console
    console.warn(`[nasaPower] unexpected fill_value ${data.header.fill_value}`);
  }

  const param = data.properties && data.properties.parameter && data.properties.parameter.PRECTOTCORR;
  if (!param || typeof param !== 'object') {
    throw new Error('NASA POWER climatology response is missing PRECTOTCORR');
  }

  const mmPerDay = MONTH_KEYS.map((k) => {
    const v = Number(param[k]);
    if (!Number.isFinite(v) || v === FILL_VALUE || v < 0) {
      throw new Error(`NASA POWER climatology returned no value for ${k}`);
    }
    return v;
  });

  const monthlyMm = mmPerDay.map((v, i) => round(v * DAYS_IN_MONTH_NON_LEAP[i], 2));
  const annualMm = round(monthlyMm.reduce((a, b) => a + b, 0), 2);
  const monsoonMm = round(monthlyMm[5] + monthlyMm[6] + monthlyMm[7] + monthlyMm[8], 2);

  return {
    monthlyMm,
    mmPerDay,
    annualMm,
    monsoonMm,
    period: `${start}-${end}`,
    // Report what POWER says it used, rather than what we asked for.
    timeStandard: (data.header && data.header.time_standard) || 'unknown',
    apiVersion: (data.header && data.header.api && data.header.api.version) || 'unknown',
  };
}

/**
 * Daily precipitation series for one point (F11 hindcast). Dates are the API's
 * `YYYYMMDD` form with no separators, and `time-standard=UTC` is mandatory:
 * without it POWER defaults to Local Solar Time and the day boundaries would not
 * match the IST season-day the log records (§13.2, §11.9).
 *
 * @param {{lat:number,lon:number}} point
 * @param {string} startYyyymmdd
 * @param {string} endYyyymmdd
 * @returns {Promise<{dates:string[], precipMm:number[]}>}
 */
async function fetchDailyPrecip(point, startYyyymmdd, endYyyymmdd) {
  const url = `${DAILY_URL}?parameters=PRECTOTCORR&community=AG`
    + `&longitude=${point.lon}&latitude=${point.lat}`
    + `&start=${startYyyymmdd}&end=${endYyyymmdd}&format=JSON&time-standard=UTC`;
  const data = await getJson(url);

  const param = data.properties && data.properties.parameter && data.properties.parameter.PRECTOTCORR;
  if (!param || typeof param !== 'object') {
    throw new Error('NASA POWER daily response is missing PRECTOTCORR');
  }
  const dates = Object.keys(param).sort();
  const precipMm = dates.map((d) => {
    const v = Number(param[d]);
    return Number.isFinite(v) && v !== FILL_VALUE ? v : null; // a gap, never a silent 0
  });
  if (dates.length === 0) throw new Error('NASA POWER daily response returned no dates');
  return { dates, precipMm };
}

function round(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

module.exports = {
  fetchClimatology,
  fetchDailyPrecip,
  CLIMATOLOGY_URL,
  DAILY_URL,
  MONTH_KEYS,
  DAYS_IN_MONTH_NON_LEAP,
  TIMEOUT_MS,
  MAX_ATTEMPTS,
};
