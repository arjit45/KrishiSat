'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// §22.1 layer 1 — unit tests for the F7 settlement ledger.
//
// The two properties that matter most are causal (no trigger, no entry) and
// deterministic (a reload is byte-identical). The second is tested by deliberately
// moving the wall clock: if the ledger read the current time anywhere, these two
// calls could not produce the same answer.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ledger = require('../services/ledger');
const members = require('../config/members');

/** A minimal result shaped like the deficit engine's output. */
function resultFor(districtId, { trigger = true, tier = 'TIER_2_SEVERE', payout = 37500, wsi = 68.9, degraded = false } = {}) {
  return {
    district: { id: districtId, name: districtId, state: 'x', zone: 'y', agroZone: 'z' },
    seasonDate: '2026-10-08',
    season: 'kharif',
    cropStage: { label: 'Grain Filling', stageId: 'grain_filling', multiplier: 1.6 },
    dataQuality: degraded ? 'PARTIAL' : 'LIVE',
    degraded,
    engineOutput: degraded
      ? null
      : {
        isTriggerMet: trigger,
        payoutTier: tier,
        payoutPerHectare: trigger ? payout : 0,
        weightedShortfallIndex: wsi,
        severityLevel: 'SEVERE_DROUGHT',
        durationIsEstimated: true,
      },
  };
}

const realDateNow = Date.now;
afterEach(() => { Date.now = realDateNow; });

describe('§18.4 / §F7 settlement ledger', () => {
  test('is causal: only triggering districts produce entries', () => {
    const entries = ledger.buildLedger([
      resultFor('jalna', { trigger: true, wsi: 68.9 }),
      resultFor('bikaner', { trigger: false, wsi: 12.4 }),
      resultFor('dewas', { trigger: true, wsi: 55.2, tier: 'TIER_1_MODERATE', payout: 25000 }),
    ]);
    assert.equal(entries.length,
      members.getMembers('jalna').length + members.getMembers('dewas').length);
    assert.ok(entries.every((e) => !/Bikaner/i.test(e.cooperative)));
    assert.ok(entries.some((e) => /Dewas/i.test(e.cooperative)));
  });

  test('a degraded district is skipped, never given a substituted amount', () => {
    const entries = ledger.buildLedger([
      resultFor('jalna', { degraded: true }),
      resultFor('bikaner', { degraded: true }),
      resultFor('dewas', { degraded: true }),
      resultFor('anantapur', { degraded: true }),
    ]);
    assert.deepEqual(entries, []);
  });

  test('no input at all yields an empty ledger, not a fabricated one', () => {
    assert.deepEqual(ledger.buildLedger([]), []);
    assert.deepEqual(ledger.buildLedger(null), []);
    assert.deepEqual(ledger.buildLedger(undefined), []);
  });

  test('member source is the F12 roster, with no selection rule of its own (§F7)', () => {
    const entries = ledger.buildLedger([resultFor('jalna')]);
    const roster = members.getMembers('jalna');
    assert.equal(entries.length, roster.length);
    entries.forEach((e, i) => {
      assert.equal(e.memberRef, `${roster[i].name} (${roster[i].memberRef})`);
      assert.equal(e.hectares, roster[i].hectares);
      assert.equal(e.cooperative, roster[i].cooperative);
    });
  });

  test('amount = hectares × that district’s tier payout, whole rupees (§F7)', () => {
    for (const [tier, payout] of [
      ['TIER_3_CATASTROPHIC', 50000],
      ['TIER_2_SEVERE', 37500],
      ['TIER_1_MODERATE', 25000],
      ['PREVENTED_SOWING', 12500],
    ]) {
      const entries = ledger.buildLedger([resultFor('jalna', { tier, payout, wsi: 60 })]);
      for (const e of entries) {
        assert.equal(e.tier, tier);
        assert.equal(e.amount, Math.round(e.hectares * payout));
        assert.ok(Number.isInteger(e.amount));
      }
    }
  });

  test('triggerIndex and cropStage come from the computation, not a constant', () => {
    const entries = ledger.buildLedger([
      resultFor('jalna', { wsi: 68.9 }),
      resultFor('dewas', { wsi: 41.7 }),
    ]);
    const wsis = new Set(entries.map((e) => e.triggerIndex));
    assert.deepEqual(wsis, new Set(['WSI: 68.9%', 'WSI: 41.7%']));
    assert.ok(entries.every((e) => e.cropStage === 'Grain Filling'));
  });

  test('timestamps ignore the wall clock entirely (§F7)', () => {
    const results = [resultFor('jalna')];
    const first = ledger.buildLedger(results);

    // Three reloaded "moments", hours apart. If anything read the current time,
    // these would differ.
    for (const fake of [Date.parse('2026-10-08T10:00:00+05:30'),
      Date.parse('2026-10-08T15:30:00+05:30'),
      Date.parse('2026-10-09T23:59:00+05:30')]) {
      Date.now = () => fake;
      assert.deepEqual(ledger.buildLedger(results), first);
    }
    Date.now = realDateNow;
  });

  test('timestamps start at the fixed 06:00 IST settlement and step by 35 minutes (§F7)', () => {
    const entries = ledger.buildLedger([resultFor('jalna')]);
    const epoch = ledger.settlementEpoch(entries[0].timestamp.slice(0, 10));
    assert.equal(ledger.formatIstTimestamp(epoch), `${entries[0].timestamp.slice(0, 10)} 06:00 IST`);

    for (let i = 1; i < entries.length; i++) {
      const a = Date.parse(entries[i - 1].timestamp.replace(' ', 'T').replace(' IST', 'Z'));
      const b = Date.parse(entries[i].timestamp.replace(' ', 'T').replace(' IST', 'Z'));
      assert.equal(b - a, ledger.ENTRY_OFFSET_MINUTES * 60 * 1000, `entry ${i}`);
    }
    assert.ok(entries.every((e) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} IST$/.test(e.timestamp)));
    assert.deepEqual(entries.map((e) => e.timestamp), [...entries.map((e) => e.timestamp)].sort());
  });

  test('the settlement instant is 06:00 IST on the requested date', () => {
    const ms = ledger.settlementEpoch('2026-10-08');
    assert.ok(ms !== null);
    assert.equal(ledger.formatIstTimestamp(ms), '2026-10-08 06:00 IST');
    assert.equal(new Date(ms).toISOString(), '2026-10-08T00:30:00.000Z');
    assert.equal(ledger.settlementEpoch('nonsense'), null);
    assert.equal(ledger.settlementEpoch('2026-13-45'), null);
  });

  test('entries carry exactly the §11.5 fields', () => {
    const entries = ledger.buildLedger([resultFor('jalna')]);
    assert.deepEqual(Object.keys(entries[0]).sort(), [
      'amount', 'cooperative', 'cropStage', 'hectares', 'memberRef',
      'tier', 'timestamp', 'triggerIndex',
    ]);
  });
});
