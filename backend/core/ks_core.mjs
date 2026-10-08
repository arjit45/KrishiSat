// ─────────────────────────────────────────────────────────────────────────────
// KrishiSat core — backend/core/ks_core.mjs                       (PRD §14.2)
//
// The SINGLE computation core. The server loads this exact file via a dynamic
// import() and the browser imports the same file served from GET /ks_core.mjs
// (§20.1); no copy is ever bundled into the frontend (§15.8).
//
// Determinism rules (§14.3), enforced by review and by the §22.1 test suite:
//   1. No platform-variant arithmetic in the hash path — 32-bit integer ops
//      only (Math.imul, >>>, |0, ^, &). No transcendentals.
//   2. Scaled-integer canonical form at the hashing boundary.
//   3. No clock, no randomness, no I/O, zero module imports.
//   4. Integer-only SHA-256, identical on every platform.
//
// Logic is unchanged by the v1.4 host-language switch: same F1–F3 math, same
// thresholds, same canonical form. The old fabricated formula
// (`100 - (precipMm*12+35)`) and the contradictory inline tier logic lived in
// server.js and were deleted there, never ported here.
// ─────────────────────────────────────────────────────────────────────────────

/** Logic version. Deliberately unchanged by v1.4 (host switch, not a logic
 *  change) — /api/health publishes this and the checksum, §18.8. */
export const KS_VERSION = '1.1.0';

/** Tier enum — §10.1 F3. */
export const TIER = Object.freeze({
  TIER_3_CATASTROPHIC: 'TIER_3_CATASTROPHIC',
  TIER_2_SEVERE: 'TIER_2_SEVERE',
  TIER_1_MODERATE: 'TIER_1_MODERATE',
  PREVENTED_SOWING: 'PREVENTED_SOWING',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
});

/** Severity mirrors the decided tier — §12.7. Never derived from WSI alone. */
export const SEVERITY = Object.freeze({
  TIER_3_CATASTROPHIC: 'CATASTROPHIC_DROUGHT',
  TIER_2_SEVERE: 'SEVERE_DROUGHT',
  TIER_1_MODERATE: 'MODERATE_DEFICIT',
  PREVENTED_SOWING: 'PREVENTED_SOWING',
  BELOW_THRESHOLD: 'NORMAL',
});

/** Human tier labels — §18.3 `tierLabel`. Display only; logic never branches on it. */
export const TIER_LABELS = Object.freeze({
  TIER_3_CATASTROPHIC: 'Catastrophic',
  TIER_2_SEVERE: 'Severe',
  TIER_1_MODERATE: 'Moderate',
  PREVENTED_SOWING: 'Prevented Sowing',
  BELOW_THRESHOLD: 'Below Threshold',
});

/** Locked thresholds — §10.1 F3, §12.1, §12.7. Change only via a PRD version bump. */
export const THRESHOLDS = Object.freeze({
  // WSI in milli-percent: 68.9 → 68900.
  wsiMilliPercent: Object.freeze({ tier3: 70000, tier2: 50000, tier1: 35000, prevented: 25000 }),
  // Real-duration OR-clauses; DISABLED when duration is estimated (§12.3).
  realDurationWeeks: Object.freeze({ tier3: 6, tier2: 4, tier1: 2 }),
  payoutPerHectare: Object.freeze({
    TIER_3_CATASTROPHIC: 50000,
    TIER_2_SEVERE: 37500,
    TIER_1_MODERATE: 25000,
    PREVENTED_SOWING: 12500,
    BELOW_THRESHOLD: 0,
  }),
  percentSumInsured: Object.freeze({
    TIER_3_CATASTROPHIC: 100,
    TIER_2_SEVERE: 75,
    TIER_1_MODERATE: 50,
    PREVENTED_SOWING: 25,
    BELOW_THRESHOLD: 0,
  }),
});

// ── §12.2 crop-stage table — the single authoritative copy ──────────────────
// [kharifLabel, kharifStageId, kharif×, rabiLabel, rabiStageId, rabi×] for months 1..12.
// Multipliers are [WORKING] (§12.2); stage month assignments are [DECIDED].
// Stage ids are the §11.2/§18.2/§18.3 `stageId`/`cropStage` enum — short ids, NOT
// slugs of the display label ("Flowering & Pollination" → `flowering`, as §18.2 shows).
const STAGE_TABLE = Object.freeze([
  ['Off-season', 'off_season', 1.0, 'Flowering', 'flowering', 1.8],                    // Jan
  ['Off-season', 'off_season', 1.0, 'Grain Filling', 'grain_filling', 1.6],            // Feb
  ['Off-season', 'off_season', 1.0, 'Maturity / Harvest', 'maturity_harvest', 0.7],    // Mar
  ['Off-season', 'off_season', 1.0, 'Post-harvest', 'post_harvest', 1.0],              // Apr
  ['Pre-sowing', 'pre_sowing', 1.0, 'Pre-sowing', 'pre_sowing', 1.0],                  // May
  ['Sowing & Germination', 'sowing_germination', 2.0, 'Off-season', 'off_season', 1.0], // Jun
  ['Sowing & Germination', 'sowing_germination', 2.0, 'Off-season', 'off_season', 1.0], // Jul
  ['Vegetative Growth', 'vegetative', 1.5, 'Off-season', 'off_season', 1.0],           // Aug
  ['Flowering & Pollination', 'flowering', 1.8, 'Off-season', 'off_season', 1.0],      // Sep
  ['Grain Filling', 'grain_filling', 1.6, 'Sowing', 'sowing', 2.0],                    // Oct
  ['Maturity / Harvest', 'maturity_harvest', 0.7, 'Sowing & Germination', 'sowing_germination', 2.0], // Nov
  ['Post-harvest', 'post_harvest', 1.0, 'Vegetative Growth', 'vegetative', 1.5],       // Dec
]);

/** Stage ids whose month is Pre-sowing / Sowing — the F3 PREVENTED_SOWING leg. */
const SOWING_STAGE_IDS = Object.freeze(new Set(['pre_sowing', 'sowing', 'sowing_germination']));

/** Normalise a season to 1 (Kharif) | 2 (Rabi). Accepts the number or the §11.2 word. */
export function ksSeasonNumber(season) {
  if (season === 1 || season === 'kharif') return 1;
  if (season === 2 || season === 'rabi') return 2;
  throw new RangeError('season must be 1|"kharif" or 2|"rabi"');
}

/** Season word for a month, 1..12. Kharif is Jun–Nov; Dec–May is Rabi. The Oct/Nov
 *  overlap resolves to Kharif, matching §12.2 / §27 ("Auto = Kharif"). Anchor for
 *  §9.3 step 2 "missing season → auto-detect from date". */
export function ksSeasonForMonth(month) {
  const m = Math.round(Number(month));
  if (!(m >= 1 && m <= 12)) throw new RangeError('month must be 1..12');
  return m >= 6 && m <= 11 ? 'kharif' : 'rabi';
}

/** Season word for an ISO date (auto-detect, §9.3 step 2, §11.2). */
export function ksSeasonForDate(dateStr) {
  const [, m] = parseISODate(dateStr);
  return ksSeasonForMonth(m);
}

/** Stage info for a calendar month + season. month 1..12; season 1|'kharif', 2|'rabi'. Pure. */
export function ksStageInfo(month, season) {
  const m = Math.round(Number(month));
  const s = ksSeasonNumber(season);
  if (!(m >= 1 && m <= 12)) throw new RangeError('month must be 1..12');
  const row = STAGE_TABLE[m - 1];
  const i = s === 1 ? 0 : 3;
  const stageLabel = row[i];
  const stageId = row[i + 1];
  const multiplier = row[i + 2];
  return {
    stageLabel,
    stageId,
    multiplier,
    isOffSeason: stageId === 'off_season',
    isSowingStage: SOWING_STAGE_IDS.has(stageId),
    month: m,
    season: s,
  };
}

export function ksStageMultiplier(month, season) {
  return ksStageInfo(month, season).multiplier;
}

/** True when the §11.2 `cropStageId` is a Pre-sowing/Sowing stage (F3 PREVENTED_SOWING leg).
 *  Accepts the stage id or, defensively, the §12.2 display label. */
export function ksIsSowingStageId(stageId) {
  const s = String(stageId);
  if (SOWING_STAGE_IDS.has(s)) return true;
  return STAGE_TABLE.some((row) =>
    (SOWING_STAGE_IDS.has(row[1]) && row[0] === s) || (SOWING_STAGE_IDS.has(row[4]) && row[3] === s));
}

// ── Calendar arithmetic — pure integer month math, no Date ──────────────────
const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2 && isLeap(y)) return 29;
  return DAYS_IN_MONTH[m - 1];
}

/** Parse 'yyyy-mm-dd' → [y, m, d] (integers). Throws on malformed input. */
function parseISODate(dateStr) {
  const s = String(dateStr);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new TypeError('date must be ISO yyyy-mm-dd');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new TypeError('date is not a valid calendar date');
  }
  return [y, mo, d];
}

function prevMonth(y, m) {
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}

/** Climatological daily expectation for one ISO date: the published baseline for
 *  the date's OWN calendar month ÷ that month's day count (F1). The caller
 *  resolves which of the two published baselines is the date's month; §27
 *  ("month rollover within the window") requires per-day month attribution. */
export function ksDailyExpectedMm(dateStr, baselineForMonthMm) {
  const [y, m] = parseISODate(dateStr);
  const b = Number(baselineForMonthMm);
  if (!Number.isFinite(b)) throw new TypeError('baselineForMonthMm must be a finite number');
  return b / daysInMonth(y, m);
}

/** Prorated climatological expectation over the trailing 30 days ENDING on
 *  dateStr inclusive (F1). Each day uses its own month's baseline, so
 *  `baselineCurrMm` — the baseline for dateStr's month — covers the days inside
 *  that month and `baselinePrevMonthMm` covers the previous calendar month's.
 *  A 30-day window can reach a third calendar month only when it opens on
 *  31 January with a short February (e.g. 1 Mar → 31 Jan…1 Mar); those few
 *  January days then use the nearest published baseline, which is the previous
 *  month's. Integer month arithmetic throughout — no Date, no clock. */
export function ksExpected30Mm(dateStr, baselineCurrMm, baselinePrevMm) {
  const [y, m, d] = parseISODate(dateStr);
  const curr = Number(baselineCurrMm);
  const prev = Number(baselinePrevMm);
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) {
    throw new TypeError('baselineCurrMm and baselinePrevMm must be finite numbers');
  }
  const [py, pm] = prevMonth(y, m);
  let cy = y, cm = m, cd = d;
  let expected = 0;
  for (let i = 0; i < 30; i++) {
    const baseline = (cy === y && cm === m) ? curr : (cy === py && cm === pm) ? prev : prev;
    expected += baseline / daysInMonth(cy, cm);
    cd -= 1;
    if (cd === 0) {
      [cy, cm] = prevMonth(cy, cm);
      cd = daysInMonth(cy, cm);
    }
  }
  return expected;
}

/** Climatological expectation for the current month-to-date — days 1..d of the
 *  date's own month (§18.2 `monthToDateExpectedMm`). Pure integer month math. */
export function ksMonthToDateExpectedMm(dateStr, baselineMonthlyMm) {
  const [y, m, d] = parseISODate(dateStr);
  const b = Number(baselineMonthlyMm);
  if (!Number.isFinite(b)) throw new TypeError('baselineMonthlyMm must be a finite number');
  return (b * d) / daysInMonth(y, m);
}

// ── Index math (F1, F4) ─────────────────────────────────────────────────────
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Banded CWSI: (FC − θ) / (FC − WP), clamped to [0,1] (F4). */
export function ksCwsi(fieldCapacity, wiltingPoint, soilMoisture) {
  const fc = Number(fieldCapacity);
  const wp = Number(wiltingPoint);
  const th = Number(soilMoisture);
  if (![fc, wp, th].every(Number.isFinite)) throw new TypeError('CWSI inputs must be finite numbers');
  const denom = fc - wp;
  return denom > 0 ? clamp((fc - th) / denom, 0, 1) : 0;
}

/**
 * Core engine: EngineInput (§11.2) → decided fields of EngineOutput (§11.3).
 * Pure. The caller (backend/engines/deficitEngine.js) assembles the input from
 * live sources and adds cwsiTrend / dataSource / dataQuality around this result.
 */
export function ksCompute(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object');
  const expected30 = Number(input.expected30Mm);
  const actual30 = Number(input.actual30Mm);
  const fc = Number(input.fieldCapacity);
  const theta = Number(input.currentSoilMoisture);
  const wp = Number(input.wiltingPoint);
  const mult = Number(input.cropStageMultiplier);
  for (const [name, v] of [['expected30Mm', expected30], ['actual30Mm', actual30],
    ['fieldCapacity', fc], ['currentSoilMoisture', theta], ['wiltingPoint', wp],
    ['cropStageMultiplier', mult]]) {
    if (!Number.isFinite(v)) throw new TypeError(`${name} must be a finite number`);
  }

  // F1 shortfall over the trailing window.
  const rainfallShortfallPercentage = expected30 > 0
    ? clamp(((expected30 - actual30) / expected30) * 100, 0, 100)
    : 0;

  // F1 soil-moisture deficit (vs field capacity).
  const soilMoistureDeficitPercentage = fc > 0 ? clamp(((fc - theta) / fc) * 100, 0, 100) : 0;

  // F4 banded CWSI.
  const cwsiProxy = ksCwsi(fc, wp, theta);

  // F1 WSI = shortfall × crop-stage multiplier.
  const weightedShortfallIndex = clamp(rainfallShortfallPercentage * mult, 0, 100);
  const wsiMilli = Math.round(weightedShortfallIndex * 1000);

  // F3 tier: real duration enables the OR-clauses; estimated disables them (§12.3).
  const weeks = Math.round(Number(input.droughtWeeks) || 0);
  const estimated = Boolean(input.durationIsEstimated);
  const isSowing = ksIsSowingStageId(input.cropStageId);
  const payoutTier = ksPayoutTier(wsiMilli, weeks, estimated, isSowing);

  return {
    rainfallShortfallPercentage,
    weightedShortfallIndex,
    weightedShortfallIndexMilli: wsiMilli,
    soilMoistureDeficitPercentage,
    cwsiProxy,
    droughtDurationWeeks: weeks,
    durationIsEstimated: estimated,
    isTriggerMet: payoutTier !== TIER.BELOW_THRESHOLD,
    payoutTier,
    severityLevel: SEVERITY[payoutTier], // §12.7: mirrors the decided tier, never WSI alone
    payoutPerHectare: THRESHOLDS.payoutPerHectare[payoutTier],
    percentSumInsured: THRESHOLDS.percentSumInsured[payoutTier],
  };
}

/** F3 tier decision, evaluated top-down; higher tier always wins.
 *  wsiMilliPct: 0..100000 · durationWeeks: 0..8 · estimated: OR-clauses OFF. */
export function ksPayoutTier(wsiMilliPct, durationWeeks, durationIsEstimated, isSowingStage) {
  const wRaw = Number(wsiMilliPct);
  if (!Number.isFinite(wRaw)) throw new TypeError('wsiMilliPct must be a finite number');
  const w = clamp(Math.round(wRaw), 0, 100000);
  const d = clamp(Math.round(Number(durationWeeks) || 0), 0, 8);
  const real = !durationIsEstimated; // §12.3: estimated duration disables the OR-clauses
  const t = THRESHOLDS;

  if (w >= t.wsiMilliPercent.tier3 || (real && d >= t.realDurationWeeks.tier3)) return TIER.TIER_3_CATASTROPHIC;
  if (w >= t.wsiMilliPercent.tier2 || (real && d >= t.realDurationWeeks.tier2)) return TIER.TIER_2_SEVERE;
  if (w >= t.wsiMilliPercent.tier1 || (real && d >= t.realDurationWeeks.tier1)) return TIER.TIER_1_MODERATE;
  if (w >= t.wsiMilliPercent.prevented && isSowingStage) return TIER.PREVENTED_SOWING;
  return TIER.BELOW_THRESHOLD;
}

// ── Receipt: scaled-int canonicalisation + integer-only SHA-256 (F10, §14.3) ─
// Scaling units (§10.2 F10 step 2): mm → thousandths; percentages and the
// stage multiplier → thousandths; soil-moisture fractions → millionths.
const FIELD_SCALE = Object.freeze({
  baselineMonthlyMm: 1000,
  baselinePrevMonthMm: 1000,
  expected30Mm: 1000,
  actual30Mm: 1000,
  cropStageMultiplier: 1000,
  currentSoilMoisture: 1000000,
  fieldCapacity: 1000000,
  wiltingPoint: 1000000,
});

/** Every numeric in the EngineInput must be covered by a scale or be an integer
 *  count (droughtWeeks). An unknown numeric is a contract drift — fail loudly. */
function canonicalValue(key, v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`canonical input ${key} is not finite`);
    const scale = key === 'droughtWeeks' ? 1 : FIELD_SCALE[key];
    if (scale === undefined) throw new TypeError(`no scaling rule for numeric field "${key}"`);
    let n = Math.round(v * scale);
    if (Object.is(n, -0) || n === 0) n = 0; // kill −0 (§14.3)
    return n;
  }
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return v;
  throw new TypeError(`canonical input ${key} has unsupported type ${typeof v}`);
}

/** Sorted-key, no-whitespace JSON (F10 step 3). Arrays keep their order. */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** Manual UTF-8 encoding — no platform text objects in the hash path. */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

// SHA-256 round constants (FIPS 180-4). Module-private and never mutated (a
// typed array cannot be frozen; nothing outside this file can reach it).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rr = (x, n) => (x >>> n) | (x << (32 - n));

/** Integer-only SHA-256 over bytes → lowercase hex (§14.3 rule 4). */
function sha256Hex(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  const total = (((len + 9) + 63) & ~63); // message + 0x80 + 8-byte length, padded to 64
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  // 64-bit message length in BITS, big-endian in the last 8 bytes (FIPS 180-4 §5.1.1).
  // Split with integer division so the low word stays an exact 32-bit value.
  const hi = Math.floor(len / 0x20000000); // 2^29 bytes = 2^32 bits per high word
  const lo = (len % 0x20000000) * 8;
  msg[total - 8] = (hi >>> 24) & 255;
  msg[total - 7] = (hi >>> 16) & 255;
  msg[total - 6] = (hi >>> 8) & 255;
  msg[total - 5] = hi & 255;
  msg[total - 4] = (lo >>> 24) & 255;
  msg[total - 3] = (lo >>> 16) & 255;
  msg[total - 2] = (lo >>> 8) & 255;
  msg[total - 1] = lo & 255;

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rr(x, 7) ^ rr(x, 18) ^ (x >>> 3);
      const s1 = rr(y, 17) ^ rr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e;
      e = (d + t1) | 0;
      d = c; c = b; b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += (H[i] >>> 0).toString(16).padStart(8, '0');
  return hex;
}

/**
 * F10 receipt over the EngineInput: scaled-int conversion (step 2) → canonical
 * string (step 3) → digest (step 4). Returns { digest, canonicalString }.
 */
export function ksReceipt(engineInput) {
  if (!engineInput || typeof engineInput !== 'object' || Array.isArray(engineInput)) {
    throw new TypeError('engineInput must be a flat object');
  }
  const canonical = {};
  for (const key of Object.keys(engineInput)) {
    canonical[key] = canonicalValue(key, engineInput[key]);
  }
  const canonicalString = stableStringify(canonical);
  return { digest: sha256Hex(utf8Bytes(canonicalString)), canonicalString };
}

/** Test-only internals (§22.1) — never used by product code paths. */
export const _internals = Object.freeze({
  sha256Hex,
  utf8Bytes,
  stableStringify,
  canonicalValue,
  FIELD_SCALE,
  STAGE_TABLE,
  SOWING_STAGE_IDS,
  parseISODate,
  prevMonth,
  daysInMonth,
  isLeap,
});
