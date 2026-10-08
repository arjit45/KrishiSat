'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// §22.1 layer 1 — unit tests over the F12 roster (config/members.js).
//
// The roster is the single owner of member identity and area, so these are the
// properties everything downstream (F7's ledger, F12's aggregation) silently
// depends on.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const members = require('../config/members');
const { DISTRICT_IDS } = require('../config/districts');

describe('§11.7 / §F12 member roster', () => {
  test('covers every district with 20–30 records (80–120 in total)', () => {
    assert.deepEqual(members.MEMBER_DISTRICT_IDS, DISTRICT_IDS);
    let total = 0;
    for (const id of DISTRICT_IDS) {
      const list = members.getMembers(id);
      assert.ok(list.length >= 20 && list.length <= 30, `${id}: ${list.length}`);
      total += list.length;
    }
    assert.ok(total >= 80 && total <= 120, `total ${total}`);
    assert.equal(members.ALL_MEMBERS.length, total);
  });

  test('name pools are district-localised and disjoint (§F12)', () => {
    const seen = new Map();
    for (const m of members.ALL_MEMBERS) {
      const previous = seen.get(m.name);
      assert.equal(previous, undefined, `${m.name} also in ${previous}`);
      seen.set(m.name, m.districtId);
    }
    // A district roster never contains another district's record.
    for (const id of DISTRICT_IDS) {
      for (const m of members.getMembers(id)) assert.equal(m.districtId, id);
    }
  });

  test('every record matches the §11.7 shape', () => {
    for (const m of members.ALL_MEMBERS) {
      assert.deepEqual(Object.keys(m).sort(),
        ['cooperative', 'districtId', 'hectares', 'memberRef', 'name']);
      assert.equal(typeof m.memberRef, 'string');
      assert.equal(typeof m.name, 'string');
      assert.equal(typeof m.cooperative, 'string');
      assert.equal(typeof m.hectares, 'number');
      assert.ok(m.memberRef.startsWith(
        { jalna: 'MH-COOP-', bikaner: 'RJ-COOP-', dewas: 'MP-COOP-', anantapur: 'AP-COOP-' }[m.districtId],
      ), m.memberRef);
      assert.match(m.memberRef, /^[A-Z]{2}-COOP-\d{4}$/);
      assert.notEqual(m.cooperative, null);
      assert.ok(m.cooperative.length > 0);
    }
  });

  test('areas are in 0.4–6.0 ha and derived from the reference hash (§F12)', () => {
    for (const m of members.ALL_MEMBERS) {
      assert.ok(m.hectares >= 0.4 && m.hectares <= 6.0, `${m.memberRef} ${m.hectares}`);
      assert.equal(m.hectares, members.areaFromRef(m.memberRef));
      // one decimal place, so 0.1 ha resolution is exact in the aggregate
      assert.equal(Math.round(m.hectares * 10), m.hectares * 10);
    }
  });

  test('the derivation is a pure function: same reference, same area, forever', () => {
    for (const m of members.ALL_MEMBERS) {
      assert.equal(members.areaFromRef(m.memberRef), m.hectares);
      assert.equal(members.areaFromRef(m.memberRef), members.areaFromRef(m.memberRef));
    }
    // …and the hash itself is pinned for a documented vector, so a future edit to
    // the seed algorithm cannot silently re-roll every member's area in place.
    assert.equal(members.fnv1a32('MH-COOP-2401'), 0x0c21af2c);
    assert.equal(members.areaFromRef('MH-COOP-2401'), 2.7);
  });

  test('a fresh import of the module yields the identical roster', async () => {
    const path = require.resolve('../config/members');
    delete require.cache[path];
    const fresh = require('../config/members');
    assert.equal(fresh.ALL_MEMBERS.length, members.ALL_MEMBERS.length);
    for (let i = 0; i < fresh.ALL_MEMBERS.length; i++) {
      assert.deepEqual(fresh.ALL_MEMBERS[i], members.ALL_MEMBERS[i]);
    }
  });
});
