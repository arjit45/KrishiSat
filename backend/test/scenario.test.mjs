'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// F14 scenario catalogue + replay window — PRD §10.2 F14, §22.1 layers 1 & 2.
//
// Hermetic: everything here reads committed files or runs pure functions. The
// properties worth a test are the ones the demo depends on — the list is NEVER
// empty for a district, and a replay that pays nothing is never labelled a
// trigger — plus the window arithmetic and the gap rules of the archive data
// path, where a substituted number would be a fabricated drought (§15.6).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const scenario = require('../services/scenario');
const { DISTRICT_IDS } = require('../config/districts');
const {
  buildCatalogue, validate, selectForDistrict, monthBounds, labelFor,
} = require('../scripts/build-scenarios');

// ── The committed catalogue (§10.2 F14: data, not code) ─────────────────────
describe('committed scenario catalogue', () => {
  const catalogue = scenario.readCatalogue();

  test('exists, is readable, and declares where it came from', () => {
    assert.ok(catalogue, 'config/scenarios.json is missing — run node scripts/build-scenarios.js');
    assert.equal(catalogue.version, 1);
    assert.match(catalogue.rule, /two scenarios per district/);
    assert.match(catalogue.derivedFrom.file, /hindcast\.json/);
    assert.match(catalogue.derivedFrom.source, /NASA POWER/);
    assert.equal(catalogue.derivedFrom.period, '2006-2025');
    assert.ok(catalogue.derivedFrom.generatedAt);
  });

  test('holds exactly two per district, eight total, with unique well-formed ids', () => {
    const scenarios = scenario.listScenarios();
    assert.equal(scenarios.length, 8);
    assert.equal(new Set(scenarios.map((s) => s.id)).size, 8);

    const perDistrict = Object.fromEntries(DISTRICT_IDS.map((id) => [id, 0]));
    for (const s of scenarios) {
      assert.match(s.id, scenario.SCENARIO_ID_RE);
      assert.equal(s.id, `${s.districtId}-${s.season}-${s.year}`);
      perDistrict[s.districtId] += 1;
      // the anchor sits inside the period the label claims (§10.2 F14)
      assert.ok(s.period.from <= s.anchorDate && s.anchorDate <= s.period.to, s.id);
      assert.ok(s.label.startsWith(s.districtName), `${s.id}: ${s.label}`);
      assert.equal(typeof s.trigger, 'boolean');
      assert.equal(typeof s.selection.peakWsi, 'number');
      assert.match(s.selection.source, /NASA POWER/);
    }
    // NEVER empty for any district — an empty district would make the demo look
    // broken in exactly the way F14 exists to prevent.
    assert.deepEqual(perDistrict, { jalna: 2, bikaner: 2, dewas: 2, anantapur: 2 });
  });

  test('lookup is exact and bounded: unknown ids resolve to null', () => {
    assert.ok(scenario.getScenario(scenario.listScenarios()[0].id));
    assert.equal(scenario.getScenario('jalna-kharif-1999'), null);
    assert.equal(scenario.getScenario('JALNA-KHARIF-2015'), null); // ids are lowercase
    assert.equal(scenario.getScenario(''), null);
    assert.equal(scenario.getScenario('x'.repeat(65)), null); // length-bounded input
    assert.equal(scenario.getScenario(null), null);
    assert.equal(scenario.getScenario({ id: 'jalna-kharif-2015' }), null);
    assert.equal(scenario.isAvailable(), true);
  });
});

// ── The selection rule, against synthetic records (§10.2 F14) ──────────────
const DISTRICT = { id: 'jalna', name: 'Jalna', state: 'Maharashtra' };
const SOURCE = 'NASA POWER daily PRECTOTCORR — 2006-2025 (F11 hindcast)';

function record(overrides) {
  return {
    districtId: 'jalna',
    year: 2015,
    season: 'kharif',
    peakWsi: 50,
    tier: 'BELOW_THRESHOLD',
    payoutPerHectare: 0,
    peakDate: '2015-09-12',
    durationWeeks: 0,
    durationMode: 'estimated',
    severityLevel: 'NORMAL',
    rainfallShortfallPercentage: 40,
    ...overrides,
  };
}

describe('catalogue selection rule (§10.2 F14)', () => {
  test('takes the two highest-WSI triggering windows, highest first', () => {
    const picked = selectForDistrict([
      record({ year: 2010, peakWsi: 72.4, tier: 'TIER_2_SEVERE', peakDate: '2010-08-01' }),
      record({ year: 2012, peakWsi: 91.2, tier: 'TIER_3_CATASTROPHIC', peakDate: '2012-07-04' }),
      record({ year: 2014, peakWsi: 40.1, tier: 'TIER_1_MODERATE', peakDate: '2014-09-09' }),
      record({ year: 2011, peakWsi: 63.0, tier: 'TIER_2_SEVERE', peakDate: '2011-06-15' }),
    ], DISTRICT, SOURCE);

    assert.equal(picked.length, 2);
    assert.deepEqual(picked.map((s) => s.id), ['jalna-kharif-2012', 'jalna-kharif-2010']);
    assert.deepEqual(picked.map((s) => s.trigger), [true, true]);
    assert.equal(picked[0].selection.peakWsi, 91.2);
    assert.equal(picked[0].label, 'Jalna — July 2012');
    assert.equal(picked[0].period.from, '2012-07-01');
    assert.equal(picked[0].period.to, '2012-07-31');
  });

  test('a district with fewer than two triggers fills the gap, labelled NON-TRIGGER', () => {
    const picked = selectForDistrict([
      record({ year: 2013, peakWsi: 88, tier: 'TIER_3_CATASTROPHIC', peakDate: '2013-08-20' }),
      record({ year: 2009, peakWsi: 22.5, tier: 'BELOW_THRESHOLD', peakDate: '2009-07-07' }),
      record({ year: 2008, peakWsi: 11.1, tier: 'BELOW_THRESHOLD', peakDate: '2008-06-06' }),
    ], DISTRICT, SOURCE);

    assert.equal(picked.length, 2);
    assert.deepEqual(picked.map((s) => s.trigger), [true, false]);
    assert.equal(picked[0].id, 'jalna-kharif-2013');
    // the fill is the highest-deficit window that remains
    assert.equal(picked[1].id, 'jalna-kharif-2009');
    assert.match(picked[1].selection.basis, /NON-TRIGGER/);
    assert.match(picked[1].selection.basis, /highest-deficit/);
  });

  test('zero triggers still yields two labelled non-triggers — never an empty list', () => {
    const picked = selectForDistrict([
      record({ year: 2007, peakWsi: 20, peakDate: '2007-09-01' }),
      record({ year: 2006, peakWsi: 15, peakDate: '2006-09-02' }),
    ], DISTRICT, SOURCE);

    assert.equal(picked.length, 2);
    assert.deepEqual(picked.map((s) => s.trigger), [false, false]);
    for (const s of picked) assert.match(s.selection.basis, /NON-TRIGGER/);
  });

  test('ties break by tier, then recency — a rebuild cannot reshuffle the list', () => {
    const records = [
      record({ year: 2016, peakWsi: 100, tier: 'TIER_3_CATASTROPHIC', peakDate: '2016-06-01' }),
      record({ year: 2020, peakWsi: 100, tier: 'TIER_3_CATASTROPHIC', peakDate: '2020-06-01' }),
      record({ year: 2018, peakWsi: 100, tier: 'TIER_2_SEVERE', peakDate: '2018-06-01' }),
    ];
    const first = selectForDistrict(records, DISTRICT, SOURCE).map((s) => s.id);
    const second = selectForDistrict([...records].reverse(), DISTRICT, SOURCE).map((s) => s.id);
    assert.deepEqual(first, ['jalna-kharif-2020', 'jalna-kharif-2016']);
    assert.deepEqual(first, second); // input order must not matter
  });

  test('the generated catalogue validates: two per district, unique ids, anchors in period', () => {
    const catalogue = buildCatalogue();
    validate(catalogue); // throws on any violation
    assert.equal(catalogue.scenarios.length, 8);
    for (const s of catalogue.scenarios) {
      assert.ok(s.period.from <= s.anchorDate && s.anchorDate <= s.period.to, s.id);
      assert.equal(s.id, `${s.districtId}-${s.season}-${s.year}`);
    }
    // and the committed file is the same list the script would produce today
    assert.deepEqual(
      catalogue.scenarios.map((s) => s.id),
      scenario.listScenarios().map((s) => s.id),
    );
  });

  test('label and period come from the anchor date, not the season-year', () => {
    // A Rabi season-year ends in May, but its anchor can be in either calendar
    // year — the label must state the period actually replayed.
    assert.deepEqual(monthBounds('2024-12-05'), { from: '2024-12-01', to: '2024-12-31' });
    assert.deepEqual(monthBounds('2024-02-29'), { from: '2024-02-01', to: '2024-02-29' }); // leap
    assert.equal(labelFor(DISTRICT, '2024-12-05'), 'Jalna — December 2024');
    assert.equal(labelFor(DISTRICT, '2025-01-01'), 'Jalna — January 2025');
    assert.throws(() => monthBounds('05-12-2024'), /ISO/);
  });
});

// ── The replay data path ───────────────────────────────────────────────────
describe('replay window arithmetic', () => {
  test('is 56 days ending on the anchor — the §12.3 duration window', () => {
    assert.deepEqual(scenario.windowFor('2015-09-12'), { from: '2015-07-19', to: '2015-09-12' });
    assert.deepEqual(scenario.windowFor('2015-01-01'), { from: '2014-11-07', to: '2015-01-01' });
    assert.throws(() => scenario.windowFor('not-a-date'), TypeError);
  });
});

describe('archived window → engine input slot (§15.6 gap rules)', () => {
  const anchor = '2015-09-12';
  const dates = Array.from({ length: 56 }, (_, i) => {
    const d = new Date(Date.parse(`${anchor}T00:00:00Z`) - (55 - i) * 86400000);
    return d.toISOString().slice(0, 10);
  });

  function windowOf({ precip = 0.4, soil = 0.12, drop = [] } = {}) {
    const gone = new Set(drop);
    return {
      from: dates[0],
      to: anchor,
      precip: dates.map((date) => ({ date, precipMm: gone.has(date) ? null : precip })),
      soil: dates.map((date) => ({ date, soilMoisture: gone.has(date) ? null : soil })),
      hoursPerDay: 24,
    };
  }

  test('shapes the window into exactly what the forecast slot returns', () => {
    const out = scenario.forecastFromWindow(windowOf(), anchor);
    assert.equal(out.daily.length, 56);
    assert.equal(out.daily[55].date, anchor);
    assert.equal(out.currentSoilMoisture, 0.12);
    assert.match(out.currentSoilMoistureTime, /ERA5-Land/);
    assert.equal(out.currentPrecipMm, 0.4);
    assert.deepEqual(out.hourlySoil, []); // no forecast model exists for a historic date
  });

  test('a gap in the trailing 30-day window throws — it is never filled with zeros', () => {
    assert.throws(
      () => scenario.forecastFromWindow(windowOf({ drop: [anchor] }), anchor),
      /trailing 30-day window incomplete/,
    );
  });

  test('a gap OUTSIDE the trailing window is tolerated (the series may trail off)', () => {
    const out = scenario.forecastFromWindow(windowOf({ drop: [dates[0]] }), anchor);
    assert.equal(out.daily.length, 56);
    assert.equal(out.daily[0].precipMm, null); // reported, not substituted
  });

  test('no soil moisture on the anchor date is a data failure, not a guess', () => {
    const w = windowOf();
    w.soil = w.soil.map((d) => (d.date === anchor ? { ...d, soilMoisture: null } : d));
    assert.throws(() => scenario.forecastFromWindow(w, anchor), /anchor date/);
  });

  test('an empty or missing series throws rather than yielding an empty window', () => {
    assert.throws(() => scenario.forecastFromWindow({ precip: [], soil: [] }, anchor), /no precipitation series/);
    assert.throws(() => scenario.forecastFromWindow({}, anchor), /no precipitation series/);
    assert.throws(() => scenario.forecastFromWindow(null, anchor), /no precipitation series/);
  });
});
