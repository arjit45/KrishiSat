'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// District registry — PRD §11.1. THE ONLY REGISTRY (§20.1).
//
// Every outbound request derives its coordinates from this file and nowhere
// else: §15.2 forbids interpolating caller-supplied values into an outbound URL,
// so `:district` is matched against these keys and the lat/lon used are the ones
// below.
//
//   fieldCapacity / wiltingPoint  §12.2, `[SOURCED]` texture-class typicals for
//                                 each soil class — never a single global constant
//   fallbackMm                    §12.5 emergency values (IMD long-term averages,
//                                 `[WORKING]`), used ONLY when NASA POWER and the
//                                 committed snapshot are both unavailable, and
//                                 always marked FALLBACK
//
// The §12.5 monthly shape is derived from `fallbackMm` by the climate cache: the
// monsoon share is split equally across Jun–Sep and the remainder equally across
// the other eight months.
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{id:string,name:string,state:string,zone:string,agroZone:string,
 *   lat:number,lon:number,primaryCrops:string[],fieldCapacity:number,
 *   wiltingPoint:number,fallbackMm:{monsoon:number,annual:number}}} District */

/** @type {Readonly<Record<string, District>>} */
const DISTRICTS = Object.freeze({
  jalna: Object.freeze({
    id: 'jalna',
    name: 'Jalna',
    state: 'Maharashtra',
    zone: 'Marathwada',
    agroZone: 'Marathwada Drought-Prone Zone',
    lat: 19.8297,
    lon: 75.88,
    primaryCrops: Object.freeze(['Cotton', 'Soybean', 'Sorghum (Jowar)', 'Sweet Orange']),
    // Black cotton soil (Vertisol)
    fieldCapacity: 0.40,
    wiltingPoint: 0.20,
    fallbackMm: Object.freeze({ monsoon: 695, annual: 782 }),
  }),
  bikaner: Object.freeze({
    id: 'bikaner',
    name: 'Bikaner',
    state: 'Rajasthan',
    zone: 'Western Arid',
    agroZone: 'Western Arid Desert Zone',
    lat: 28.0167,
    lon: 73.3119,
    primaryCrops: Object.freeze(['Bajra (Pearl Millet)', 'Moth Bean', 'Guar', 'Mustard']),
    // Sandy loam (Aridisol)
    fieldCapacity: 0.18,
    wiltingPoint: 0.07,
    fallbackMm: Object.freeze({ monsoon: 267, annual: 279 }),
  }),
  dewas: Object.freeze({
    id: 'dewas',
    name: 'Dewas',
    state: 'Madhya Pradesh',
    zone: 'Malwa Plateau',
    agroZone: 'Malwa Plateau Agricultural Belt',
    lat: 22.9624,
    lon: 76.0507,
    primaryCrops: Object.freeze(['Soybean', 'Wheat', 'Gram (Chickpea)', 'Cotton']),
    // Black/red mixed
    fieldCapacity: 0.35,
    wiltingPoint: 0.17,
    fallbackMm: Object.freeze({ monsoon: 913, annual: 1010 }),
  }),
  anantapur: Object.freeze({
    id: 'anantapur',
    name: 'Anantapur',
    state: 'Andhra Pradesh',
    zone: 'Rayalaseema',
    agroZone: 'Rayalaseema Semi-Arid Zone',
    lat: 14.6819,
    lon: 77.6006,
    primaryCrops: Object.freeze(['Groundnut', 'Sunflower', 'Paddy', 'Red Chilli']),
    // Red loam (Alfisol)
    fieldCapacity: 0.28,
    wiltingPoint: 0.14,
    fallbackMm: Object.freeze({ monsoon: 554, annual: 568 }),
  }),
});

/** Registry keys, in registry order. The only valid `:district` values. */
const DISTRICT_IDS = Object.freeze(Object.keys(DISTRICTS));

/**
 * Look up a district. Case/whitespace tolerant because the key arrives from a
 * URL; the returned object is a registry entry, never a caller-supplied object.
 * @param {string} key
 * @returns {District|undefined}
 */
function getDistrict(key) {
  if (typeof key !== 'string') return undefined;
  return DISTRICTS[key.toLowerCase().trim()];
}

/**
 * The §11.1 projection used by `GET /api/districts` and the `/api/weather`
 * payload — `id` is included so a client can key results without a second call.
 * @param {District} d
 */
function toPublicDistrict(d) {
  return {
    id: d.id,
    name: d.name,
    state: d.state,
    zone: d.zone,
    agroZone: d.agroZone,
    lat: d.lat,
    lon: d.lon,
    primaryCrops: d.primaryCrops.slice(),
    fieldCapacity: d.fieldCapacity,
    wiltingPoint: d.wiltingPoint,
  };
}

module.exports = { DISTRICTS, DISTRICT_IDS, getDistrict, toPublicDistrict };
