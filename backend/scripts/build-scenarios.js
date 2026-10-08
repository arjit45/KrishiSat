'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// scripts/build-scenarios.js — build-time F14 scenario catalogue
// (PRD §10.2 F14, §9.4, §29.4 question 8)
//
//   cd backend && node scripts/build-scenarios.js
//
// Reads the committed hindcast (config/hindcast.json) and writes the committed
// catalogue config/scenarios.json: TWO scenarios per district, eight total — the
// two highest-WSI windows in which the hindcast shows a trigger. Where a district
// has fewer than two triggering windows, the gap is filled by its highest-deficit
// window and that entry is LABELLED A NON-TRIGGER, so a replay that pays nothing
// is never presented as though it had triggered. The list is never empty for any
// district: an empty district would make the demo look broken in exactly the way
// F14 exists to prevent.
//
// The catalogue is DATA, not code (§10.2 F14): this script runs at build time,
// its output is committed, and no request path ever runs it. `GET /api/scenarios`
// and `GET /api/weather/:district?scenario=` read the file and compute nothing.
//
// Every scenario names a district and a period, so the label a user reads
// ("Jalna — September 2015") is derived from the ANCHOR DATE — the hindcast's
// peak season-day for that window — rather than from the season-year, whose Rabi
// half opens in the previous calendar year.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { DISTRICTS, DISTRICT_IDS } = require('../config/districts');
const hindcast = require('../services/hindcast');

const OUT_PATH = path.join(__dirname, '..', 'config', 'scenarios.json');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const RANK = ['BELOW_THRESHOLD', 'PREVENTED_SOWING', 'TIER_1_MODERATE', 'TIER_2_SEVERE', 'TIER_3_CATASTROPHIC'];
const rankOf = (tier) => RANK.indexOf(tier);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar month an anchor date falls in — the "period" the label states. */
function monthBounds(dateStr) {
  const m = ISO_RE.exec(dateStr);
  if (!m) throw new Error(`anchor date is not ISO yyyy-mm-dd: ${dateStr}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

/** `Jalna — September 2015`, from the district registry and the anchor date. */
function labelFor(district, anchorDate) {
  const m = ISO_RE.exec(anchorDate);
  const month = MONTHS[Number(m[2]) - 1];
  return `${district.name} — ${month} ${m[1]}`;
}

/**
 * Order windows so the "highest-WSI" rule of §10.2 F14 is total and repeatable.
 * peakWsi first, then tier (a higher tier at the same WSI is the stronger
 * window), then the more recent anchor, then kharif before rabi. Anchor dates
 * never collide across seasons — kharif is Jun–Nov and rabi Dec–May — so this
 * order is strict and a rebuild cannot reshuffle the list.
 */
function byPeak(a, b) {
  if (b.peakWsi !== a.peakWsi) return b.peakWsi - a.peakWsi;
  const rank = rankOf(b.tier) - rankOf(a.tier);
  if (rank !== 0) return rank;
  if (a.peakDate !== b.peakDate) return a.peakDate < b.peakDate ? 1 : -1;
  return a.season === 'kharif' ? -1 : 1;
}

function entryFor(record, district, trigger, sourceLabel) {
  const anchorDate = record.peakDate;
  const districtId = record.districtId;
  return {
    // §10.2 F14: `<district>-<season>-<year>` — and because it is part of the
    // canonical engine input (§11.2), a scenario receipt can never collide with a
    // live receipt for the same district and date.
    id: `${districtId}-${record.season}-${record.year}`,
    districtId,
    districtName: district.name,
    state: district.state,
    season: record.season,
    year: record.year,
    label: labelFor(district, anchorDate),
    period: monthBounds(anchorDate),
    // The single day the replay evaluates. The engine then reads its trailing
    // 30-day index window and 8-week duration window backwards from here.
    anchorDate,
    trigger,
    selection: {
      basis: trigger
        ? 'a triggering window in the F11 hindcast, chosen by peak WSI'
        : 'highest-deficit window — this district has fewer than two triggering windows, so this entry is a NON-TRIGGER',
      peakWsi: record.peakWsi,
      payoutTier: record.tier,
      payoutPerHectare: record.payoutPerHectare,
      severityLevel: record.severityLevel,
      rainfallShortfallPercentage: record.rainfallShortfallPercentage,
      durationMode: record.durationMode,
      source: sourceLabel,
    },
  };
}

/**
 * Pick a district's two scenarios: the highest-WSI triggering windows first,
 * then — only if there are fewer than two of those — the highest-deficit windows
 * regardless of whether they triggered, each one labelled `trigger: false`.
 */
function selectForDistrict(records, district, sourceLabel) {
  const ordered = [...records].sort(byPeak);
  const triggers = ordered.filter((r) => r.tier !== 'BELOW_THRESHOLD');
  const nonTriggers = ordered.filter((r) => r.tier === 'BELOW_THRESHOLD');

  const picked = triggers.slice(0, 2).map((r) => entryFor(r, district, true, sourceLabel));
  while (picked.length < 2 && nonTriggers.length > 0) {
    picked.push(entryFor(nonTriggers.shift(), district, false, sourceLabel));
  }
  if (picked.length < 2) {
    throw new Error(`district ${district.id} has fewer than two replayable windows — F14 forbids an empty list`);
  }
  return picked;
}

function buildCatalogue() {
  const snapshot = hindcast.readSnapshot();
  if (!snapshot || !snapshot.districts) {
    throw new Error(
      'the committed hindcast snapshot is missing. Run: cd backend && node scripts/run-hindcast.js',
    );
  }

  const sourceLabel = `${snapshot.source} — ${snapshot.period} (F11 hindcast)`;
  const scenarios = [];
  for (const id of DISTRICT_IDS) {
    const records = (snapshot.districts[id] && snapshot.districts[id].records) || [];
    if (records.length === 0) {
      throw new Error(`the hindcast snapshot has no records for ${id} — refusing to write a catalogue with a hole in it`);
    }
    scenarios.push(...selectForDistrict(records, DISTRICTS[id], sourceLabel));
  }

  // §10.2 F14, stated in the file so a reader of the data does not need the PRD:
  // two per district, eight total, selected by peak WSI, non-triggers labelled.
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    rule: 'two scenarios per district (eight total): the two highest-WSI windows in which the F11 hindcast shows a trigger; where a district has fewer than two, its highest-deficit window fills the gap and is labelled a non-trigger',
    derivedFrom: {
      file: 'backend/config/hindcast.json',
      source: snapshot.source,
      period: snapshot.period,
      generatedAt: snapshot.generatedAt,
      note: 'the catalogue is selected from the hindcast; each replay itself runs on Open-Meteo Archive data, a different reanalysis (§28.8)',
    },
    scenarios,
  };
}

function validate(catalogue) {
  const ids = new Set();
  const perDistrict = Object.fromEntries(DISTRICT_IDS.map((id) => [id, 0]));
  for (const s of catalogue.scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
    ids.add(s.id);
    if (!(s.districtId in perDistrict)) throw new Error(`scenario ${s.id} names an unknown district`);
    if (s.id !== `${s.districtId}-${s.season}-${s.year}`) throw new Error(`scenario id ${s.id} does not match its parts`);
    if (s.period.from > s.anchorDate || s.anchorDate > s.period.to) {
      throw new Error(`scenario ${s.id}: anchor date is outside its own period`);
    }
    perDistrict[s.districtId] += 1;
  }
  for (const id of DISTRICT_IDS) {
    if (perDistrict[id] !== 2) throw new Error(`district ${id} has ${perDistrict[id]} scenarios, expected 2`);
  }
  if (catalogue.scenarios.length !== DISTRICT_IDS.length * 2) throw new Error('catalogue is not two-per-district');
}

function main() {
  const catalogue = buildCatalogue();
  validate(catalogue);
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(catalogue, null, 2)}\n`);

  console.log(`  scenarios → ${path.relative(process.cwd(), OUT_PATH)}`);
  for (const id of DISTRICT_IDS) {
    for (const s of catalogue.scenarios.filter((x) => x.districtId === id)) {
      console.log(`    ${s.id.padEnd(20)} ${s.label.padEnd(26)} ${s.trigger ? 'trigger' : 'NON-TRIGGER'}  WSI ${s.selection.peakWsi}`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`  build-scenarios failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildCatalogue, validate, selectForDistrict, monthBounds, labelFor, byPeak };
