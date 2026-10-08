'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// scripts/fetch-baseline.js — build-time climatology refresh (PRD §12.4, §13.2)
//
//   cd backend && node scripts/fetch-baseline.js
//
// Fetches the NASA POWER 30-year monthly precipitation climatology for the four
// registry districts and commits the result to
// backend/config/climate-baseline.json. The server seeds its climate cache from
// that file, so the first request never waits on NASA POWER and never serves a
// reduced-fidelity fallback for it (§12.4 "Cold start is designed out").
//
// Run this manually or from CI when the baseline should be refreshed; a 30-year
// average changes at most once a year. The GIT-COMMITTED output is the artifact
// that ships — this script never runs on a request path.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { DISTRICTS, DISTRICT_IDS } = require('../config/districts');
const { fetchClimatology, CLIMATOLOGY_URL, MONTH_KEYS, DAYS_IN_MONTH_NON_LEAP } = require('../services/nasaPower');

// Explicit, never the undocumented API default (§13.2).
const PERIOD = Object.freeze({ start: 1991, end: 2020 });

const OUT_PATH = path.join(__dirname, '..', 'config', 'climate-baseline.json');

async function main() {
  const districts = {};
  const failures = [];
  let reportedStandard = null;
  let apiVersion = null;

  for (const id of DISTRICT_IDS) {
    const d = DISTRICTS[id];
    try {
      const c = await fetchClimatology({ lat: d.lat, lon: d.lon }, PERIOD);
      reportedStandard = c.timeStandard;
      apiVersion = c.apiVersion;
      districts[id] = {
        lat: d.lat,
        lon: d.lon,
        monthlyMm: c.monthlyMm,
        annualMm: c.annualMm,
        monsoonMm: c.monsoonMm,
      };
      process.stdout.write(`  ${id.padEnd(10)} annual ${c.annualMm} mm · monsoon ${c.monsoonMm} mm\n`);
    } catch (err) {
      failures.push(`${id}: ${err.message}`);
      process.stdout.write(`  ${id.padEnd(10)} FAILED — ${err.message}\n`);
    }
  }

  if (Object.keys(districts).length === 0) {
    process.stderr.write('\nNo district could be fetched; the existing snapshot is left untouched.\n');
    process.exitCode = 1;
    return;
  }
  if (failures.length > 0) {
    // A partial refresh would silently mix periods across districts; refuse it.
    process.stderr.write(`\nRefusing to write a partial snapshot:\n  ${failures.join('\n  ')}\n`);
    process.exitCode = 1;
    return;
  }

  const snapshot = {
    source: 'NASA POWER Climatology API (MERRA-2)',
    endpoint: CLIMATOLOGY_URL,
    parameter: 'PRECTOTCORR',
    community: 'AG',
    period: `${PERIOD.start}-${PERIOD.end}`,
    periodNote: 'Passed explicitly as start/end on every request; the API default is undocumented and never relied upon (PRD §13.2).',
    units: 'mm per calendar month',
    conversion: `PRECTOTCORR is returned in mm/day; monthly mm = value × days in a non-leap month (${DAYS_IN_MONTH_NON_LEAP.join('/')}) — PRD §13.2.`,
    monthOrder: MONTH_KEYS,
    timeStandardRequested: 'UTC',
    timeStandardReported: reportedStandard,
    apiVersion,
    fetchedAt: new Date().toISOString(),
    note: 'Committed build-time snapshot (PRD §12.4). Read from disk at startup; no request waits on NASA POWER.',
    districts,
  };

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${path.relative(process.cwd(), OUT_PATH)} at ${snapshot.fetchedAt}\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-baseline failed: ${err.message}\n`);
  process.exitCode = 1;
});
