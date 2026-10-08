'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Phenology engine — PRD §10.1 F2, §12.2.
//
// "wraps the core" (§20.1): the stage table and its multipliers live in
// backend/core/ks_core.mjs and NOWHERE else (§14.2 "All thresholds and constants
// live in this one module, never duplicated elsewhere — not in the engines").
// This file adds only what the core deliberately does not know: the district
// allowlist check and the display month name.
//
// The core is an ES module, so it is reached with a dynamic import() exactly as
// §14.2 prescribes. Node caches by specifier, and every module in this backend
// imports the SAME specifier, so one module instance backs the whole server.
// ─────────────────────────────────────────────────────────────────────────────

const { getDistrict } = require('../config/districts');

const CORE_SPECIFIER = '../core/ks_core.mjs';
let corePromise = null;

/** The one loaded core module (§14.2). */
function loadCore() {
  if (!corePromise) corePromise = import(CORE_SPECIFIER);
  return corePromise;
}

const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']);

/**
 * Resolve the active season. A user selection always wins; otherwise the season
 * is auto-detected from the date, Kharif if the month is Jun–Nov (§10.1 F2).
 *
 * @param {string} dateStr ISO yyyy-mm-dd
 * @param {string|undefined} requested 'kharif' | 'rabi' | undefined
 * @returns {Promise<{season:'kharif'|'rabi', seasonSource:'user'|'auto'}>}
 */
async function resolveSeason(dateStr, requested) {
  const core = await loadCore();
  if (requested !== undefined && requested !== null && requested !== '') {
    if (requested !== 'kharif' && requested !== 'rabi') {
      throw new TypeError('season must be exactly "kharif" or "rabi"');
    }
    return { season: requested, seasonSource: 'user' };
  }
  return { season: core.ksSeasonForDate(dateStr), seasonSource: 'auto' };
}

/**
 * §10.1 F2 — `getCropStage(districtId, date, season)`. Pure: no I/O and no clock
 * beyond the date it is given, so the same arguments always return the same stage.
 *
 * `districtId` is validated against the registry but does not select the stage:
 * the §12.2 calendar is national by design, and inventing per-district calendars
 * would be a second table (§12.2 "There is one table").
 *
 * @param {string} districtId
 * @param {string} dateStr ISO yyyy-mm-dd
 * @param {'kharif'|'rabi'} season
 * @returns {Promise<{stageLabel:string,stageId:string,multiplier:number,month:number,
 *   monthName:string,season:string,seasonNumber:number,isOffSeason:boolean,
 *   isSowingStage:boolean}>}
 */
async function getCropStage(districtId, dateStr, season) {
  if (!getDistrict(districtId)) {
    throw new RangeError(`unknown district "${districtId}"`);
  }
  const core = await loadCore();
  const { season: resolved } = await resolveSeason(dateStr, season);
  const month = Number(String(dateStr).slice(5, 7));
  const info = core.ksStageInfo(month, resolved);
  return {
    stageLabel: info.stageLabel,
    stageId: info.stageId,
    multiplier: info.multiplier,
    month: info.month,
    monthName: MONTH_NAMES[info.month - 1],
    season: resolved,
    seasonNumber: info.season,
    isOffSeason: info.isOffSeason,
    isSowingStage: info.isSowingStage,
  };
}

module.exports = { getCropStage, resolveSeason, loadCore, MONTH_NAMES, CORE_SPECIFIER };
