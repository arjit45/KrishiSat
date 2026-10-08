// ─────────────────────────────────────────────────────────────────────────────
// §22.1 layers 1–5 against the SHIPPED core: backend/core/ks_core.mjs
//
// These tests import the committed module itself. §14.4 forbids a second
// implementation, so there is no reimplementation to test against and no
// constant is restated here: every threshold is read from the module's own
// exported THRESHOLDS/TIER/SEVERITY. The only literal numbers are the ones the
// PRD publishes as worked examples (§18.2, §29.3) and the FIPS SHA-256 vectors.
//
// Run: npm test   (node --test, no new runtime dependency — §22)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  KS_VERSION,
  TIER,
  SEVERITY,
  TIER_LABELS,
  THRESHOLDS,
  ksSeasonNumber,
  ksSeasonForMonth,
  ksSeasonForDate,
  ksStageInfo,
  ksStageMultiplier,
  ksIsSowingStageId,
  ksDailyExpectedMm,
  ksExpected30Mm,
  ksMonthToDateExpectedMm,
  ksCwsi,
  ksCompute,
  ksPayoutTier,
  ksReceipt,
  _internals,
} from '../core/ks_core.mjs';

const CORE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/ks_core.mjs');
const CORE_SOURCE = readFileSync(CORE_PATH, 'utf8');

const MILLI = (pct) => Math.round(pct * 1000);
const SEASONS = [1, 2];
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const RANK = [TIER.BELOW_THRESHOLD, TIER.PREVENTED_SOWING, TIER.TIER_1_MODERATE,
  TIER.TIER_2_SEVERE, TIER.TIER_3_CATASTROPHIC];
const rank = (tier) => RANK.indexOf(tier);

/** The §18.2 worked example input, verbatim from the PRD. */
const PRD_EXAMPLE = Object.freeze({
  districtId: 'jalna',
  season: 'kharif',
  date: '2026-09-30',
  scenarioId: null,
  baselineMonthlyMm: 142.5,
  baselinePrevMonthMm: 118.0,
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
});

// ── Layer 1 — module surface & determinism rules (§14.3) ────────────────────
describe('core module surface and §14.3 determinism rules', () => {
  test('publishes the §14.2 exports', () => {
    assert.equal(typeof KS_VERSION, 'string');
    assert.equal(typeof ksStageMultiplier, 'function');
    assert.equal(typeof ksPayoutTier, 'function');
    assert.equal(typeof ksCompute, 'function');
    assert.equal(typeof ksReceipt, 'function');
    assert.equal(KS_VERSION, '1.1.0'); // §18.8: v1.4 changes the host, not the logic
  });

  test('every tier carries a severity (§12.7 mirror) and a §18.3 label', () => {
    const tiers = Object.values(TIER);
    assert.equal(tiers.length, 5);
    for (const t of tiers) {
      assert.equal(typeof SEVERITY[t], 'string', `SEVERITY missing for ${t}`);
      assert.equal(typeof TIER_LABELS[t], 'string', `TIER_LABELS missing for ${t}`);
      assert.ok(Object.values(SEVERITY).includes(SEVERITY[t]));
    }
    assert.equal(SEVERITY[TIER.BELOW_THRESHOLD], 'NORMAL');
  });

  test('thresholds and enums are frozen', () => {
    for (const obj of [TIER, SEVERITY, TIER_LABELS, THRESHOLDS, THRESHOLDS.wsiMilliPercent,
      THRESHOLDS.realDurationWeeks, THRESHOLDS.payoutPerHectare, THRESHOLDS.percentSumInsured]) {
      assert.ok(Object.isFrozen(obj));
    }
  });

  test('no clock, randomness, I/O, transcendentals or imports in the source (§14.3)', () => {
    const forbidden = [
      [/\bnew\s+Date\b/, 'Date construction'],
      [/\bDate\.now\b/, 'Date.now'],
      [/Math\.random/, 'Math.random'],
      [/Math\.(sin|cos|tan|asin|acos|atan|exp|log|pow|sqrt|cbrt|hypot)\b/, 'transcendental'],
      [/node:crypto/, 'node:crypto'],
      [/\brequire\s*\(/, 'require()'],
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bprocess\s*\./, 'process'],
      [/^\s*import\s/m, 'module import'],
      [/\bXMLHttpRequest\b|\bsetTimeout\b|\bperformance\b/, 'ambient I/O'],
    ];
    for (const [re, what] of forbidden) {
      assert.equal(re.test(CORE_SOURCE), false, `core must not use ${what}`);
    }
  });

  test('identical input yields identical output and digest (§22.1 layer 2)', () => {
    const a = ksCompute(PRD_EXAMPLE);
    const b = ksCompute({ ...PRD_EXAMPLE });
    assert.deepEqual(a, b);
    const ra = ksReceipt(PRD_EXAMPLE);
    const rb = ksReceipt({ ...PRD_EXAMPLE });
    assert.equal(ra.digest, rb.digest);
    assert.equal(ra.canonicalString, rb.canonicalString);
  });
});

// ── Layer 1 — §12.2 stage table ─────────────────────────────────────────────
describe('§12.2 crop stage table', () => {
  const ALLOWED_MULTIPLIERS = [0.7, 1.0, 1.5, 1.6, 1.8, 2.0];

  test('all 12 months × both seasons resolve, with a documented multiplier', () => {
    for (const m of MONTHS) {
      for (const s of SEASONS) {
        const info = ksStageInfo(m, s);
        assert.equal(info.month, m);
        assert.equal(info.season, s);
        assert.ok(ALLOWED_MULTIPLIERS.includes(info.multiplier), `m=${m} s=${s}`);
        assert.equal(info.multiplier, ksStageMultiplier(m, s));
        assert.equal(typeof info.stageId, 'string');
        assert.ok(/^[a-z0-9_]+$/.test(info.stageId), `stageId is not an id: ${info.stageId}`);
        assert.equal(info.isOffSeason, info.stageId === 'off_season');
        assert.equal(info.isSowingStage, ksIsSowingStageId(info.stageId));
        if (info.isOffSeason) assert.equal(info.multiplier, 1.0);
      }
    }
  });

  test('every month/season pair is a recognised sowing stage or not, consistently', () => {
    for (const m of MONTHS) {
      for (const s of SEASONS) {
        const info = ksStageInfo(m, s);
        assert.equal(typeof info.isSowingStage, 'boolean');
      }
    }
  });

  test('§18.2 fixture: September + Kharif is Flowering & Pollination, id "flowering", ×1.8', () => {
    const info = ksStageInfo(9, 1);
    assert.equal(info.stageLabel, 'Flowering & Pollination');
    assert.equal(info.stageId, 'flowering'); // the §18.2 example publishes this exact id
    assert.equal(info.multiplier, 1.8);
    assert.equal(info.isOffSeason, false);
    assert.equal(info.isSowingStage, false);
  });

  test('§12.2 anchors: peak Kharif sowing months and off-season structure', () => {
    assert.equal(ksStageMultiplier(6, 1), 2.0); // Sowing & Germination
    assert.equal(ksStageMultiplier(7, 1), 2.0);
    assert.equal(ksStageMultiplier(8, 1), 1.5); // Vegetative Growth
    assert.equal(ksStageMultiplier(9, 1), 1.8); // Flowering & Pollination
    assert.equal(ksStageMultiplier(10, 1), 1.6); // Grain Filling
    assert.equal(ksStageMultiplier(11, 1), 0.7); // Maturity / Harvest
    assert.equal(ksStageMultiplier(12, 1), 1.0); // Post-harvest
    // Rabi
    assert.equal(ksStageMultiplier(1, 2), 1.8);
    assert.equal(ksStageMultiplier(2, 2), 1.6);
    assert.equal(ksStageMultiplier(3, 2), 0.7);
    assert.equal(ksStageMultiplier(10, 2), 2.0); // Sowing
    assert.equal(ksStageMultiplier(12, 2), 1.5);
    // Pre-sowing in both seasons
    assert.equal(ksStageMultiplier(5, 1), 1.0);
    assert.equal(ksStageMultiplier(5, 2), 1.0);
    assert.ok(ksIsSowingStageId(ksStageInfo(5, 1).stageId)); // May is a PREVENTED_SOWING month
    // Rabi's off-season is the Kharif growing season
    assert.ok(ksStageInfo(7, 2).isOffSeason);
    assert.ok(ksStageInfo(1, 1).isOffSeason);
  });

  test('season accepts the number or the §11.2 word, rejects anything else', () => {
    assert.equal(ksSeasonNumber(1), 1);
    assert.equal(ksSeasonNumber('kharif'), 1);
    assert.equal(ksSeasonNumber(2), 2);
    assert.equal(ksSeasonNumber('rabi'), 2);
    for (const bad of ['KHARIF', 'monsoon', 0, 3, null, undefined, '']) {
      assert.throws(() => ksSeasonNumber(bad), RangeError);
    }
    assert.equal(ksStageMultiplier(9, 'kharif'), ksStageMultiplier(9, 1));
    assert.equal(ksStageMultiplier(1, 'rabi'), ksStageMultiplier(1, 2));
    for (const bad of [0, 13, -1, 'x']) assert.throws(() => ksStageInfo(bad, 1), RangeError);
    for (const bad of [0, 13]) assert.throws(() => ksSeasonForMonth(bad), RangeError);
  });

  test('season auto-detect: Jun–Nov Kharif, Dec–May Rabi, Oct/Nov overlap → Kharif', () => {
    for (const m of [6, 7, 8, 9, 10, 11]) {
      assert.equal(ksSeasonForMonth(m), 'kharif', `month ${m}`);
    }
    for (const m of [12, 1, 2, 3, 4, 5]) {
      assert.equal(ksSeasonForMonth(m), 'rabi', `month ${m}`);
    }
    assert.equal(ksSeasonForMonth(10), 'kharif'); // overlap resolves to Kharif (§12.2, §27)
    assert.equal(ksSeasonForDate('2026-10-01'), 'kharif');
    assert.equal(ksSeasonForDate('2026-05-31'), 'rabi');
  });

  test('sowing-stage ids gate the PREVENTED_SOWING leg', () => {
    const sowing = ['pre_sowing', 'sowing', 'sowing_germination'];
    for (const id of sowing) assert.equal(ksIsSowingStageId(id), true, id);
    for (const id of ['flowering', 'vegetative', 'grain_filling', 'maturity_harvest',
      'post_harvest', 'off_season', 'nonsense', '']) {
      assert.equal(ksIsSowingStageId(id), false, id);
    }
  });
});

// ── Layer 1 — F1 index math ─────────────────────────────────────────────────
describe('F1 shortfall, soil deficit, WSI (PRD §10.1 F1, §18.2)', () => {
  test('§18.2 fixture reproduces the published numbers', () => {
    const out = ksCompute(PRD_EXAMPLE);
    assert.equal(round1(out.rainfallShortfallPercentage), 38.3);
    assert.equal(round1(out.weightedShortfallIndex), 68.9);
    assert.equal(round1(out.soilMoistureDeficitPercentage), 55.0);
    assert.equal(out.cwsiProxy, 1.0);
    assert.equal(out.droughtDurationWeeks, 5);
    assert.equal(out.durationIsEstimated, false);
    assert.equal(out.payoutTier, TIER.TIER_2_SEVERE);
    assert.equal(out.severityLevel, 'SEVERE_DROUGHT');
    assert.equal(out.payoutPerHectare, 37500);
    assert.equal(out.percentSumInsured, 75);
    assert.equal(out.isTriggerMet, true);
  });

  test('shortfall = (expected − actual)/expected, clamped to [0,100]', () => {
    const base = { ...PRD_EXAMPLE, cropStageMultiplier: 1.0, cropStageId: 'off_season' };
    assert.equal(ksCompute({ ...base, expected30Mm: 100, actual30Mm: 100 }).rainfallShortfallPercentage, 0);
    assert.equal(ksCompute({ ...base, expected30Mm: 100, actual30Mm: 60 }).rainfallShortfallPercentage, 40);
    assert.equal(ksCompute({ ...base, expected30Mm: 100, actual30Mm: 0 }).rainfallShortfallPercentage, 100);
    // More rain than expected is not a negative shortfall
    assert.equal(ksCompute({ ...base, expected30Mm: 100, actual30Mm: 250 }).rainfallShortfallPercentage, 0);
    // Zero expectation cannot divide by zero
    assert.equal(ksCompute({ ...base, expected30Mm: 0, actual30Mm: 0 }).rainfallShortfallPercentage, 0);
    // §27: district with zero rain in the window → 100%
    assert.equal(ksCompute({ ...base, expected30Mm: 139.5, actual30Mm: 0 }).rainfallShortfallPercentage, 100);
  });

  test('WSI = shortfall × stage multiplier, clamped to [0,100]', () => {
    const base = { ...PRD_EXAMPLE, expected30Mm: 100, actual30Mm: 50, cropStageMultiplier: 1.0 };
    assert.equal(ksCompute(base).weightedShortfallIndex, 50);
    assert.equal(ksCompute({ ...base, cropStageMultiplier: 2.0 }).weightedShortfallIndex, 100);
    assert.equal(ksCompute({ ...base, cropStageMultiplier: 0.7 }).weightedShortfallIndex, 35);
    assert.equal(ksCompute({ ...base, actual30Mm: 0, cropStageMultiplier: 1.8 }).weightedShortfallIndex, 100);
    assert.ok(ksCompute({ ...base, actual30Mm: 0, cropStageMultiplier: 1.8 })
      .weightedShortfallIndex <= 100);
  });

  test('weightedShortfallIndexMilli is the integer form of the same value', () => {
    for (const mult of [0.7, 1.0, 1.5, 1.6, 1.8, 2.0]) {
      for (const actual of [0, 33.3, 86.1, 100, 139.5]) {
        const out = ksCompute({ ...PRD_EXAMPLE, cropStageMultiplier: mult, actual30Mm: actual });
        assert.equal(out.weightedShortfallIndexMilli, Math.round(out.weightedShortfallIndex * 1000));
        assert.ok(Number.isInteger(out.weightedShortfallIndexMilli));
      }
    }
  });

  test('soil-moisture deficit is relative to field capacity (§18.2)', () => {
    const base = { ...PRD_EXAMPLE };
    assert.equal(ksCompute({ ...base, currentSoilMoisture: 0.4 }).soilMoistureDeficitPercentage, 0);
    assert.equal(round1(ksCompute({ ...base, currentSoilMoisture: 0.2 }).soilMoistureDeficitPercentage), 50);
    assert.equal(ksCompute({ ...base, currentSoilMoisture: 0 }).soilMoistureDeficitPercentage, 100);
    // Saturated soil can't be a negative deficit (§27)
    assert.equal(ksCompute({ ...base, currentSoilMoisture: 0.9 }).soilMoistureDeficitPercentage, 0);
    assert.equal(ksCompute({ ...base, fieldCapacity: 0, currentSoilMoisture: 0 }).soilMoistureDeficitPercentage, 0);
    // §27: Bikaner's low field capacity still yields a sane number
    assert.equal(round1(ksCompute({ ...base, fieldCapacity: 0.18, wiltingPoint: 0.07, currentSoilMoisture: 0.07 })
      .soilMoistureDeficitPercentage), 61.1);
  });

  test('F4 CWSI is banded, clamped to [0,1], and never collapses at low FC (§27)', () => {
    assert.equal(ksCwsi(0.4, 0.2, 0.4), 0);   // saturated → dry edge 0
    assert.ok(Math.abs(ksCwsi(0.4, 0.2, 0.3) - 0.5) < 1e-12); // midpoint
    assert.equal(ksCwsi(0.4, 0.2, 0.2), 1);   // at wilting point
    assert.equal(ksCwsi(0.4, 0.2, 0.0), 1);   // below WP → clamped
    assert.equal(ksCwsi(0.4, 0.2, 0.9), 0);   // above FC → clamped
    assert.equal(ksCwsi(0.18, 0.07, 0.07), 1); // Bikaner low FC
    assert.equal(ksCwsi(0.18, 0.07, 0.18), 0);
    assert.equal(ksCwsi(0.4, 0.4, 0.2), 0);   // degenerate band cannot divide by zero
    for (let i = 0; i <= 100; i++) {
      const v = ksCwsi(0.4, 0.2, i / 100);
      assert.ok(v >= 0 && v <= 1, `CWSI out of range at θ=${i / 100}`);
    }
    assert.throws(() => ksCwsi(0.4, 0.2, NaN), TypeError);
  });

  test('rejects malformed / non-finite engine input', () => {
    assert.throws(() => ksCompute(null), TypeError);
    assert.throws(() => ksCompute('x'), TypeError);
    assert.throws(() => ksCompute({ ...PRD_EXAMPLE, actual30Mm: NaN }), TypeError);
    assert.throws(() => ksCompute({ ...PRD_EXAMPLE, currentSoilMoisture: undefined }), TypeError);
    assert.throws(() => ksCompute({ ...PRD_EXAMPLE, cropStageMultiplier: Infinity }), TypeError);
    assert.throws(() => ksCompute({ ...PRD_EXAMPLE, expected30Mm: 'lots' }), TypeError);
  });
});

// ── Layer 1 — F3 tiers, duration, PREVENTED_SOWING ──────────────────────────
describe('F3 tier decisions and §12.3 duration gate', () => {
  const t = THRESHOLDS.wsiMilliPercent;
  const d = THRESHOLDS.realDurationWeeks;

  test('WSI thresholds fire exactly at their boundary and not one milli below', () => {
    assert.equal(ksPayoutTier(t.tier3 - 1, 0, false, false), TIER.TIER_2_SEVERE);
    assert.equal(ksPayoutTier(t.tier3, 0, false, false), TIER.TIER_3_CATASTROPHIC);
    assert.equal(ksPayoutTier(t.tier2 - 1, 0, false, false), TIER.TIER_1_MODERATE);
    assert.equal(ksPayoutTier(t.tier2, 0, false, false), TIER.TIER_2_SEVERE);
    assert.equal(ksPayoutTier(t.tier1 - 1, 0, false, false), TIER.BELOW_THRESHOLD);
    assert.equal(ksPayoutTier(t.tier1, 0, false, false), TIER.TIER_1_MODERATE);
    assert.equal(ksPayoutTier(t.prevented - 1, 0, false, true), TIER.BELOW_THRESHOLD);
    assert.equal(ksPayoutTier(t.prevented, 0, false, true), TIER.PREVENTED_SOWING);
    assert.equal(ksPayoutTier(t.prevented, 0, false, false), TIER.BELOW_THRESHOLD);
  });

  test('real duration OR-clauses raise the tier independently (§12.3, §29.3)', () => {
    assert.equal(ksPayoutTier(MILLI(30), d.tier3, false, false), TIER.TIER_3_CATASTROPHIC);
    assert.equal(ksPayoutTier(MILLI(30), d.tier2, false, false), TIER.TIER_2_SEVERE);
    assert.equal(ksPayoutTier(MILLI(30), d.tier1, false, false), TIER.TIER_1_MODERATE);
    assert.equal(ksPayoutTier(MILLI(30), d.tier1 - 1, false, false), TIER.BELOW_THRESHOLD);
    assert.equal(ksPayoutTier(0, d.tier3, false, false), TIER.TIER_3_CATASTROPHIC);
    assert.equal(ksPayoutTier(0, 8, false, true), TIER.TIER_3_CATASTROPHIC);
    // A real OR-clause outranks the prevented-sowing leg
    assert.equal(ksPayoutTier(MILLI(30), d.tier1, false, true), TIER.TIER_1_MODERATE);
  });

  test('estimated duration disables every OR-clause (§12.3)', () => {
    for (const weeks of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(ksPayoutTier(0, weeks, true, false), TIER.BELOW_THRESHOLD, `weeks=${weeks}`);
      assert.equal(ksPayoutTier(MILLI(30), weeks, true, true), TIER.PREVENTED_SOWING, `weeks=${weeks}`);
      assert.equal(ksPayoutTier(MILLI(30), weeks, true, false), TIER.BELOW_THRESHOLD, `weeks=${weeks}`);
    }
  });

  test('PREVENTED_SOWING needs a sowing stage AND WSI ≥ its threshold', () => {
    assert.equal(ksPayoutTier(MILLI(25), 0, true, true), TIER.PREVENTED_SOWING);
    assert.equal(ksPayoutTier(MILLI(25), 0, true, false), TIER.BELOW_THRESHOLD);
    assert.equal(ksPayoutTier(MILLI(24.999), 0, true, true), TIER.BELOW_THRESHOLD);
    // §18.3 request path: the id comes from the caller, so ids must be accepted
    for (const id of ['pre_sowing', 'sowing', 'sowing_germination']) {
      const out = ksCompute({ ...PRD_EXAMPLE, cropStageId: id, cropStageMultiplier: 1.0,
        expected30Mm: 100, actual30Mm: 70, droughtWeeks: 0, durationIsEstimated: true });
      assert.equal(out.payoutTier, TIER.PREVENTED_SOWING, id);
      assert.equal(out.severityLevel, 'PREVENTED_SOWING', id);
      assert.equal(out.payoutPerHectare, THRESHOLDS.payoutPerHectare[TIER.PREVENTED_SOWING]);
    }
  });

  test('ksCompute routes the stage id and duration flags into the tier decision', () => {
    const sowing = ksCompute({ ...PRD_EXAMPLE, cropStageId: 'sowing_germination',
      cropStageMultiplier: 1.0, expected30Mm: 100, actual30Mm: 70,
      droughtWeeks: 6, durationIsEstimated: false });
    assert.equal(sowing.payoutTier, TIER.TIER_3_CATASTROPHIC); // real OR-clause
    const estimated = ksCompute({ ...PRD_EXAMPLE, cropStageId: 'sowing_germination',
      cropStageMultiplier: 1.0, expected30Mm: 100, actual30Mm: 70,
      droughtWeeks: 6, durationIsEstimated: true });
    assert.equal(estimated.payoutTier, TIER.PREVENTED_SOWING); // OR-clauses off
  });

  test('isTriggerMet is exactly "payout is not zero"', () => {
    for (let wsi = 0; wsi <= 100; wsi += 0.5) {
      for (const est of [true, false]) {
        const out = ksCompute({ ...PRD_EXAMPLE, expected30Mm: 100, actual30Mm: 100 - wsi,
          cropStageMultiplier: 1, cropStageId: 'flowering', droughtWeeks: 0,
          durationIsEstimated: est });
        assert.equal(out.isTriggerMet, out.payoutTier !== TIER.BELOW_THRESHOLD);
        assert.equal(out.isTriggerMet, out.payoutPerHectare > 0);
      }
    }
  });

  test('out-of-range duration and WSI are clamped, not thrown (§18.3 bounds)', () => {
    assert.equal(ksPayoutTier(MILLI(200), 99, false, false), TIER.TIER_3_CATASTROPHIC);
    assert.equal(ksPayoutTier(MILLI(-50), 8, true, false), TIER.BELOW_THRESHOLD);
    assert.equal(ksPayoutTier(MILLI(50), -3, false, false), TIER.TIER_2_SEVERE);
    // Duration is rounded then clamped to 0..8; 99.4 → 8 weeks → the tier-3 OR-clause
    assert.equal(ksPayoutTier(MILLI(0), 99.4, false, false), TIER.TIER_3_CATASTROPHIC);
    assert.equal(ksPayoutTier(MILLI(25), 99, true, true), TIER.PREVENTED_SOWING);
    assert.throws(() => ksPayoutTier(NaN, 0, false, false), TypeError);
  });
});

// ── Layer 4 + 5 — coherence, exhaustive sweep, properties ───────────────────
describe('§22.1 layers 4–5: severity coherence, band partition, properties', () => {
  test('severity mirrors the decided tier for every input in both duration modes', () => {
    let n = 0;
    for (let wsiMilli = 0; wsiMilli <= 100000; wsiMilli += 100) {
      for (let weeks = 0; weeks <= 8; weeks++) {
        for (const est of [true, false]) {
          for (const sowing of [true, false]) {
            const tier = ksPayoutTier(wsiMilli, weeks, est, sowing);
            const out = ksCompute({ ...PRD_EXAMPLE, cropStageId: sowing ? 'pre_sowing' : 'flowering',
              cropStageMultiplier: 1, expected30Mm: 100000, actual30Mm: 100000 - wsiMilli,
              droughtWeeks: weeks, durationIsEstimated: est });
            assert.equal(out.severityLevel, SEVERITY[out.payoutTier],
              `WSI ${wsiMilli} w${weeks} est=${est} sow=${sowing}`);
            assert.equal(out.payoutTier, tier);
            n++;
          }
        }
      }
    }
    assert.ok(n > 30000, `swept ${n} combinations`);
  });

  test('the four numeric WSI bands partition 0–100 with no gap or overlap', () => {
    const t = THRESHOLDS.wsiMilliPercent;
    const bandOf = (wsiMilli, sowing) => {
      if (wsiMilli >= t.tier3) return TIER.TIER_3_CATASTROPHIC;
      if (wsiMilli >= t.tier2) return TIER.TIER_2_SEVERE;
      if (wsiMilli >= t.tier1) return TIER.TIER_1_MODERATE;
      if (wsiMilli >= t.prevented && sowing) return TIER.PREVENTED_SOWING;
      return TIER.BELOW_THRESHOLD;
    };
    for (let wsiMilli = 0; wsiMilli <= 100000; wsiMilli += 1) {
      for (const sowing of [true, false]) {
        // estimated duration = WSI alone → the band function must match exactly
        assert.equal(ksPayoutTier(wsiMilli, 0, true, sowing), bandOf(wsiMilli, sowing), `wsi=${wsiMilli}`);
      }
    }
    // Boundary walk: each band boundary belongs to exactly one side
    for (const edge of [t.prevented, t.tier1, t.tier2, t.tier3]) {
      assert.notEqual(ksPayoutTier(edge, 0, true, true), ksPayoutTier(edge - 1, 0, true, true));
    }
  });

  test('all five severity labels are reachable', () => {
    const seen = new Set();
    for (let wsiMilli = 0; wsiMilli <= 100000; wsiMilli += 50) {
      for (let weeks = 0; weeks <= 8; weeks++) {
        for (const est of [true, false]) {
          for (const sowing of [true, false]) {
            seen.add(SEVERITY[ksPayoutTier(wsiMilli, weeks, est, sowing)]);
          }
        }
      }
    }
    for (const label of Object.values(SEVERITY)) {
      assert.ok(seen.has(label), `unreachable severity label: ${label}`);
    }
    assert.equal(seen.size, Object.values(SEVERITY).length);
  });

  test('property: a larger WSI never lowers the tier (monotonicity)', () => {
    for (let weeks = 0; weeks <= 8; weeks++) {
      for (const est of [true, false]) {
        for (const sowing of [true, false]) {
          let prev = -1;
          for (let wsiMilli = 0; wsiMilli <= 100000; wsiMilli += 250) {
            const r = rank(ksPayoutTier(wsiMilli, weeks, est, sowing));
            assert.ok(r >= prev, `tier fell at wsi=${wsiMilli} w=${weeks} est=${est}`);
            prev = r;
          }
        }
      }
    }
  });

  test('property: payout is always one of the §12.1 sums, within ₹0–₹50,000', () => {
    const allowed = [
      THRESHOLDS.payoutPerHectare[TIER.BELOW_THRESHOLD],
      THRESHOLDS.payoutPerHectare[TIER.PREVENTED_SOWING],
      THRESHOLDS.payoutPerHectare[TIER.TIER_1_MODERATE],
      THRESHOLDS.payoutPerHectare[TIER.TIER_2_SEVERE],
      THRESHOLDS.payoutPerHectare[TIER.TIER_3_CATASTROPHIC],
    ];
    assert.deepEqual(allowed, [0, 12500, 25000, 37500, 50000]); // §12.1 published sums
    for (let wsiMilli = 0; wsiMilli <= 100000; wsiMilli += 500) {
      for (let weeks = 0; weeks <= 8; weeks++) {
        for (const est of [true, false]) {
          const tier = ksPayoutTier(wsiMilli, weeks, est, true);
          const payout = THRESHOLDS.payoutPerHectare[tier];
          assert.ok(allowed.includes(payout));
          assert.ok(payout >= 0 && payout <= 50000);
          assert.ok(THRESHOLDS.percentSumInsured[tier] >= 0 && THRESHOLDS.percentSumInsured[tier] <= 100);
        }
      }
    }
    // Percentages match the published table, tier by tier
    assert.equal(THRESHOLDS.percentSumInsured[TIER.TIER_3_CATASTROPHIC], 100);
    assert.equal(THRESHOLDS.percentSumInsured[TIER.TIER_2_SEVERE], 75);
    assert.equal(THRESHOLDS.percentSumInsured[TIER.TIER_1_MODERATE], 50);
    assert.equal(THRESHOLDS.percentSumInsured[TIER.PREVENTED_SOWING], 25);
    assert.equal(THRESHOLDS.percentSumInsured[TIER.BELOW_THRESHOLD], 0);
  });

  test('property: shortfall ∈ [0,100], WSI ∈ [0,100], CWSI ∈ [0,1] on a dense grid', () => {
    for (let actual = 0; actual <= 300; actual += 3.7) {
      for (let mult of [0.7, 1.0, 1.5, 1.6, 1.8, 2.0]) {
        const out = ksCompute({ ...PRD_EXAMPLE, expected30Mm: 139.5, actual30Mm: actual, cropStageMultiplier: mult });
        assert.ok(out.rainfallShortfallPercentage >= 0 && out.rainfallShortfallPercentage <= 100);
        assert.ok(out.weightedShortfallIndex >= 0 && out.weightedShortfallIndex <= 100);
        assert.ok(out.soilMoistureDeficitPercentage >= 0 && out.soilMoistureDeficitPercentage <= 100);
        assert.ok(out.cwsiProxy >= 0 && out.cwsiProxy <= 1);
      }
    }
  });
});

// ── Layer 1 — trailing-window proration & calendar edges ────────────────────
describe('F1 trailing-30-day proration and calendar edges (§27)', () => {
  test('a 30-day window inside a 30-day month equals that month\'s whole baseline', () => {
    assert.equal(ksExpected30Mm('2026-09-30', 142.5, 118), 142.5);   // Sep 1–30
    assert.equal(ksExpected30Mm('2026-04-30', 30, 99), 30);          // Apr 1–30
    assert.equal(ksExpected30Mm('2026-06-30', 30, 99), 30);          // Jun 1–30
    // A 31-day month cannot be covered by 30 days: the window is 30/31 of it
    assert.ok(Math.abs(ksExpected30Mm('2026-01-30', 20, 9) - 30 * (20 / 31)) < 1e-9);
    assert.equal(ksExpected30Mm('2026-03-31', 31, 9), 30); // Mar 2–31
    assert.equal(ksExpected30Mm('2026-08-30', 31, 9), 30); // Aug 1–30
  });

  test('a straddling window prorates each day by its own month', () => {
    // 2026-09-15 → Aug 17–31 (15 days at Aug baseline/31) + Sep 1–15 (15 at Sep/30)
    const got = ksExpected30Mm('2026-09-15', 142.5, 118);
    const want = 15 * (142.5 / 30) + 15 * (118 / 31);
    assert.ok(Math.abs(got - want) < 1e-9, `${got} != ${want}`);
    // Month rollover on the 1st keeps the window stable (§27 "1st–3rd of the month")
    const monthStart = ksExpected30Mm('2026-09-01', 142.5, 118);
    const dayBefore = ksExpected30Mm('2026-08-31', 142.5, 118);
    assert.ok(monthStart > 0 && dayBefore > 0);
  });

  test('a 30-day window that reaches a third calendar month uses the nearest baseline', () => {
    // 2026-03-01 → 2026-01-31 (1 day) + Feb 1–28 (28 days) + Mar 1 (1 day)
    const got = ksExpected30Mm('2026-03-01', 40, 25);
    const want = (25 / 31) + 28 * (25 / 28) + (40 / 31); // Jan uses nearest published = Feb's
    assert.ok(Math.abs(got - want) < 1e-9, `${got} != ${want}`);
  });

  test('leap years are handled', () => {
    assert.equal(_internals.isLeap(2028), true);
    assert.equal(_internals.isLeap(2026), false);
    assert.equal(_internals.isLeap(2000), true);
    assert.equal(_internals.isLeap(2100), false);
    assert.equal(_internals.daysInMonth(2028, 2), 29);
    assert.equal(_internals.daysInMonth(2026, 2), 28);
    assert.equal(ksExpected30Mm('2028-02-29', 29, 31) > 0, true);
    // 2028-02-29 is a real date; 2026-02-29 is not
    assert.throws(() => ksExpected30Mm('2026-02-29', 29, 31), TypeError);
    assert.throws(() => ksExpected30Mm('2100-02-29', 29, 31), TypeError);
    assert.equal(ksDailyExpectedMm('2028-02-29', 29), 1); // 29 mm over 29 days
  });

  test('daily expectation divides the month baseline by that month\'s day count', () => {
    assert.equal(ksDailyExpectedMm('2026-09-30', 150), 5);
    assert.equal(ksDailyExpectedMm('2026-02-28', 28), 1);
    assert.equal(ksDailyExpectedMm('2027-02-28', 28), 1); // non-leap
    // §27: each day of a straddling window uses its own month
    assert.notEqual(ksDailyExpectedMm('2026-08-31', 118), ksDailyExpectedMm('2026-09-01', 142.5));
  });

  test('month-to-date expectation counts only the elapsed days (§18.2)', () => {
    assert.equal(ksMonthToDateExpectedMm('2026-09-15', 142.5), 15 * (142.5 / 30));
    assert.equal(ksMonthToDateExpectedMm('2026-09-30', 142.5), 142.5);
    assert.equal(ksMonthToDateExpectedMm('2026-09-01', 142.5), 142.5 / 30);
    assert.equal(ksMonthToDateExpectedMm('2026-09-15', 142.5) <= 142.5, true);
  });

  test('malformed dates are rejected, never silently coerced', () => {
    for (const bad of ['2026-9-15', '15-09-2026', '2026/09/15', '', 'today', 20260915, null]) {
      assert.throws(() => ksExpected30Mm(bad, 100, 100), TypeError, String(bad));
    }
    assert.throws(() => ksExpected30Mm('2026-13-01', 100, 100), TypeError);
    assert.throws(() => ksExpected30Mm('2026-00-10', 100, 100), TypeError);
    assert.throws(() => ksExpected30Mm('2026-09-31', 100, 100), TypeError);
    assert.throws(() => ksExpected30Mm('2026-09-15', NaN, 100), TypeError);
    assert.throws(() => ksDailyExpectedMm('2026-09-15', undefined), TypeError);
    assert.throws(() => ksMonthToDateExpectedMm('2026-09-15', 'x'), TypeError);
  });
});

// ── Layer 2 + 3 — canonical form, integer SHA-256, cross-environment ────────
describe('F10 receipt: scaled-int canonical form and integer SHA-256 (§10.2, §14.3)', () => {
  test('canonical string is whitespace-free, key-sorted JSON of plain integers', () => {
    const { canonicalString } = ksReceipt(PRD_EXAMPLE);
    assert.equal(/\s/.test(canonicalString), false, 'no insignificant whitespace');
    assert.equal(/\./.test(canonicalString), false, 'no floating point');
    assert.equal(/e[+-]?\d/i.test(canonicalString), false, 'no exponential notation');
    assert.equal(/-0(?![.\d])/.test(canonicalString), false, 'no negative zero');
    const keys = Object.keys(JSON.parse(canonicalString));
    assert.deepEqual(keys, [...keys].sort());
    for (const [k, v] of Object.entries(JSON.parse(canonicalString))) {
      if (typeof v === 'number') assert.ok(Number.isInteger(v), `${k} is not an integer: ${v}`);
    }
  });

  test('scaled units follow §10.2 step 2 (mm → thousandths, fractions → millionths)', () => {
    const decoded = JSON.parse(ksReceipt(PRD_EXAMPLE).canonicalString);
    assert.equal(decoded.expected30Mm, 139500);
    assert.equal(decoded.actual30Mm, 86100);
    assert.equal(decoded.baselineMonthlyMm, 142500);
    assert.equal(decoded.fieldCapacity, 400000);
    assert.equal(decoded.wiltingPoint, 200000);
    assert.equal(decoded.currentSoilMoisture, 180000);
    assert.equal(decoded.cropStageMultiplier, 1800);
    assert.equal(decoded.droughtWeeks, 5);
    assert.equal(decoded.districtId, 'jalna');
    assert.equal(decoded.scenarioId, null);
    assert.equal(decoded.durationIsEstimated, false);
  });

  test('the digest matches Node\'s crypto SHA-256 over the same canonical bytes', () => {
    for (const input of [
      PRD_EXAMPLE,
      { ...PRD_EXAMPLE, districtId: 'bikaner', actual30Mm: 0, scenarioId: 'bikaner-2016' },
      { ...PRD_EXAMPLE, districtId: 'anantapur', season: 'rabi', date: '2027-01-05',
        baselineMonthlyMm: 3.25, baselinePrevMonthMm: 12, expected30Mm: 0.5, actual30Mm: 0.125 },
    ]) {
      const { digest, canonicalString } = ksReceipt(input);
      const nodeDigest = createHash('sha256').update(Buffer.from(canonicalString, 'utf8')).digest('hex');
      assert.equal(digest, nodeDigest);
      assert.match(digest, /^[0-9a-f]{64}$/);
    }
  });

  test('integer SHA-256 matches the FIPS 180-4 vectors, including multi-byte UTF-8', () => {
    const hex = (s) => _internals.sha256Hex(_internals.utf8Bytes(s));
    assert.equal(hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(hex('a'.repeat(64)),
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
    assert.equal(hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // 1000 × 'a' exercises many blocks
    assert.equal(hex('a'.repeat(1000)),
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    // UTF-8 encoding is manual, so non-ASCII must round-trip identically
    const s = 'Jalna — जलना ₹ 2';
    assert.equal(hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
    assert.equal(hex('€'), createHash('sha256').update('€', 'utf8').digest('hex'));
    // Lone surrogate must not throw and must stay deterministic
    assert.equal(hex('\ud800'), hex('\ud800'));
  });

  test('stableStringify sorts nested keys and keeps array order', () => {
    assert.equal(_internals.stableStringify({ b: 1, a: [{ d: 2, c: 1 }] }), '{"a":[{"c":1,"d":2}],"b":1}');
    assert.equal(_internals.stableStringify(null), 'null');
    assert.equal(_internals.stableStringify('x'), '"x"');
  });

  test('§22.1 layer 3: dynamic import (server) and static import (browser) agree', async () => {
    const fresh = await import(pathToFileURL(CORE_PATH).href + '?fresh=1');
    const staticReceipt = ksReceipt(PRD_EXAMPLE);
    const dynamicReceipt = fresh.ksReceipt({ ...PRD_EXAMPLE });
    assert.equal(dynamicReceipt.canonicalString, staticReceipt.canonicalString);
    assert.equal(dynamicReceipt.digest, staticReceipt.digest);
    assert.equal(fresh.KS_VERSION, KS_VERSION);
    // …and a third, separately-mirrored instance (query-busted re-import) too
    const again = await import(pathToFileURL(CORE_PATH).href + '?fresh=2');
    assert.equal(again.ksReceipt({ ...PRD_EXAMPLE }).digest, staticReceipt.digest);
  });

  test('scenario id is part of the canonical input, so receipts cannot collide (§10.2 F14)', () => {
    const live = ksReceipt({ ...PRD_EXAMPLE, scenarioId: null });
    const replay = ksReceipt({ ...PRD_EXAMPLE, scenarioId: 'jalna-2016' });
    assert.notEqual(live.digest, replay.digest);
    assert.notEqual(live.canonicalString, replay.canonicalString);
    assert.equal(JSON.parse(ksReceipt({ ...PRD_EXAMPLE }).canonicalString).scenarioId, null);
  });

  test('unknown numeric fields and unsupported types fail loudly, not silently', () => {
    assert.throws(() => ksReceipt({ ...PRD_EXAMPLE, mysteryMm: 1 }), TypeError);
    assert.throws(() => ksReceipt({ ...PRD_EXAMPLE, extra: { nested: true } }), TypeError);
    assert.throws(() => ksReceipt({ ...PRD_EXAMPLE, actual30Mm: NaN }), TypeError);
    assert.throws(() => ksReceipt(null), TypeError);
    assert.throws(() => ksReceipt([1, 2]), TypeError);
    assert.throws(() => ksReceipt('str'), TypeError);
  });

  test('tier boundaries do not depend on float formatting (§14.3 class of bug)', () => {
    // 68.9 × 1000 is 68900.00000000001 in FP; the milli form must still be exact
    assert.equal(MILLI(68.9), 68900);
    const out = ksCompute({ ...PRD_EXAMPLE });
    assert.ok(Number.isInteger(out.weightedShortfallIndexMilli));
    assert.equal(ksPayoutTier(out.weightedShortfallIndexMilli, out.droughtDurationWeeks,
      out.durationIsEstimated, false), out.payoutTier);
  });
});

function round1(v) {
  return Math.round(v * 10) / 10;
}
