'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// F12 member roster — the SINGLE owner of member identity, name and area
// (§10.2 F12, §11.7, §20.1). F7's ledger draws every entry from here and applies
// no selection rule of its own.
//
// This is illustrative sample data, NOT real PII (§11.7). Nothing is stored: the
// roster is this committed file, and any hectare edit lives in the browser and
// travels with each request (§18.7). A per-instance store is explicitly rejected —
// on a serverless runtime it would lose edits *between requests*, not merely at
// restart (§16.3).
//
// Areas are drawn deterministically from a hash of the member reference (§F12), so
// the roster and every amount derived from it are stable across reloads and
// machines. The hash below is integer-only and is NOT a second implementation of
// the receipt core (§14.4): it computes no F1–F4 value, is never consulted to decide
// a payout, and only spreads illustrative areas across 0.4–6.0 ha.
//
// Name pools are per district on purpose. A single global array shared across
// districts is a defect (§F12): a Jalna cooperative must never show a Telugu name.
// The pools are asserted disjoint at load, so that rule cannot rot silently.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed range for illustrative member areas (§F12), in hectares. */
const AREA_MIN_HA = 0.4;
const AREA_MAX_HA = 6.0;

/** FNV-1a, 32-bit, integer-only. Deterministic, dependency-free, locale-free. */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Illustrative area for a member reference: `hash(ref)` mapped onto
 * [AREA_MIN_HA, AREA_MAX_HA] at 0.1 ha resolution. Deterministic by construction —
 * the same reference yields the same area on every machine and every reload.
 * @param {string} memberRef
 */
function areaFromRef(memberRef) {
  const spread = (fnv1a32(memberRef) % 10000) / 10000;
  return Math.round((AREA_MIN_HA + spread * (AREA_MAX_HA - AREA_MIN_HA)) * 10) / 10;
}

/** Per-district seeds: cooperative name, reference prefix, and the local name pool. */
const SEEDS = Object.freeze({
  jalna: {
    cooperative: 'Jalna Taluka Shetkari Sahakari Sanstha Maryadit',
    refPrefix: 'MH-COOP-',
    refStart: 2401,
    names: [
      'Ramesh Pawar', 'Sanjay Deshmukh', 'Anil Kadam', 'Amol Patil', 'Vikas Shinde',
      'Sunil Jadhav', 'Dnyaneshwar More', 'Ganesh Gaikwad', 'Prakash Kulkarni',
      'Balasaheb Jagtap', 'Manoj Bhosale', 'Nilesh Shelke', 'Sachin Ahire',
      'Vinod Rathod', 'Gajanan Wagh', 'Santosh Chavan', 'Rajendra Sonawane',
      'Deepak Khedkar', 'Pravin Dhage', 'Ashok Mundhe', 'Kiran Tambe',
      'Sandeep Ghodke', 'Yashwant Kolhe', 'Nandkumar Bansode', 'Ravi Ingole',
    ],
  },
  bikaner: {
    cooperative: 'Bikaner Zila Kisan Utpadak Sahakari Samiti',
    refPrefix: 'RJ-COOP-',
    refStart: 2401,
    names: [
      'Hari Singh Bhati', 'Mahendra Choudhary', 'Gopal Purohit',
      'Devendra Singh Rathore', 'Vijay Solanki', 'Om Prakash Jat',
      'Bhanwar Lal Godara', 'Shyam Sunder Paliwal', 'Kishan Singh Shekhawat',
      'Naresh Bishnoi', 'Raju Gehlot', 'Suresh Saran', 'Mohan Lal Regar',
      'Deepak Vyas', 'Ashok Suthar', 'Prahlad Meghwal', 'Kanhaiya Lal Swami',
      'Sitaram Jakhar', 'Bhagirath Choudhary', 'Ramniwas Beniwal',
      'Jagdish Prajapat', 'Dinesh Tanwar', 'Arjun Singh Deora',
      'Vinod Kumar Saini', 'Kailash Chand Sharma',
    ],
  },
  dewas: {
    cooperative: 'Dewas Jila Kisan Sewa Sahakari Samiti Maryadit',
    refPrefix: 'MP-COOP-',
    refStart: 2401,
    names: [
      'Rajendra Malviya', 'Yogesh Joshi', 'Mahesh Verma', 'Suresh Chouhan',
      'Anil Patidar', 'Ramesh Yadav', 'Dinesh Thakur', 'Mukesh Parmar',
      'Kailash Mandloi', 'Bhupendra Solanki', 'Omkar Tiwari', 'Sanjay Bhandari',
      'Ajay Vishwakarma', 'Rakesh Soni', 'Pramod Agrawal', 'Naveen Nagar',
      'Girdhari Lal Pawar', 'Jitendra Chouhan', 'Ravi Dubey', 'Santosh Mehra',
      'Vikram Rathore', 'Hariom Sharma', 'Devendra Khatri', 'Pankaj Jain',
      'Sunil Bhawsar',
    ],
  },
  anantapur: {
    cooperative: 'Anantapur Jilla Raitu Sahakara Sangham',
    refPrefix: 'AP-COOP-',
    refStart: 2401,
    names: [
      'K. Raghavulu', 'N. Venkatesh', 'M. Lakshmaiah', 'P. Srinivasa Rao',
      'Chandrasekhar Reddy', 'B. Ramachandraiah', 'G. Sivaramakrishna',
      'T. Naganna', 'V. Subbarao', 'Y. Peddanna', 'S. Chennakesavulu',
      'D. Anjaneyulu', 'R. Bhaskar Reddy', 'K. Obulapathi', 'J. Chinnappa',
      'U. Rammohan', 'A. Sreenivasulu', 'B. Sreeramulu', 'P. Nagabhushanam',
      'Ch. Lakshmidevi', 'Sk. Mahaboob Basha', 'K. Venkataramana',
      'G. Pullanna', 'T. Sivamma', 'B. Narasimhulu',
    ],
  },
});

/** @typedef {{memberRef:string,name:string,cooperative:string,districtId:string,hectares:number}} MemberRecord */

function buildRoster() {
  /** @type {Record<string, ReadonlyArray<MemberRecord>>} */
  const byDistrict = {};
  const seenNames = new Map(); // name → districtId, to enforce the §F12 locality rule

  for (const [districtId, seed] of Object.entries(SEEDS)) {
    byDistrict[districtId] = Object.freeze(seed.names.map((name, i) => {
      const previous = seenNames.get(name);
      if (previous) {
        throw new Error(`config/members.js: "${name}" appears in both ${previous} and ${districtId}; name pools must be district-local (§F12)`);
      }
      seenNames.set(name, districtId);
      const memberRef = `${seed.refPrefix}${seed.refStart + i}`;
      return Object.freeze({
        memberRef,
        name,
        cooperative: seed.cooperative,
        districtId,
        hectares: areaFromRef(memberRef),
      });
    }));
  }
  return Object.freeze(byDistrict);
}

/** @type {Readonly<Record<string, ReadonlyArray<MemberRecord>>>} */
const MEMBERS_BY_DISTRICT = buildRoster();

/** Flat roster, in registry order. */
const ALL_MEMBERS = Object.freeze(
  Object.keys(MEMBERS_BY_DISTRICT).flatMap((id) => MEMBERS_BY_DISTRICT[id]),
);

/** Members per district — the "illustrative sample of N members" label (§F12). */
const MEMBERS_PER_DISTRICT = Object.freeze(
  Object.fromEntries(Object.entries(MEMBERS_BY_DISTRICT).map(([id, list]) => [id, list.length])),
);

/**
 * The roster for one district. Returns an empty array for an unknown district so a
 * caller cannot mistake "no such district" for "no members" without saying so.
 * @param {string} districtId
 * @returns {ReadonlyArray<MemberRecord>}
 */
function getMembers(districtId) {
  return MEMBERS_BY_DISTRICT[districtId] || [];
}

/** Cooperative name for a district, or null. */
function getCooperative(districtId) {
  const seed = SEEDS[districtId];
  return seed ? seed.cooperative : null;
}

/** Every district that has a roster, in registry order. */
const MEMBER_DISTRICT_IDS = Object.freeze(Object.keys(MEMBERS_BY_DISTRICT));

module.exports = {
  MEMBERS_BY_DISTRICT,
  MEMBER_DISTRICT_IDS,
  MEMBERS_PER_DISTRICT,
  ALL_MEMBERS,
  getMembers,
  getCooperative,
  areaFromRef,
  fnv1a32,
  AREA_MIN_HA,
  AREA_MAX_HA,
};
