'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// scripts/run-hindcast.js — build-time hindcast (PRD §10.2 F11, §9.4, §12.4)
//
//   cd backend && node scripts/run-hindcast.js [--years=20]
//
// Fetches NASA POWER daily precipitation for each registry district and replays
// the SHIPPED core over every season-year, then commits the result to
// backend/config/hindcast.json. `/api/backtest/:district` reads that file and
// computes nothing on a request path, which is the whole reason the hindcast is
// build-time: POWER warns that repeated requests for the same point may be
// blocked, and a serverless request must not sit through a 20-year replay.
//
// Requests are chunked by year so a single failure costs one chunk, and the
// chunk boundaries are logged so a gap in the committed series is visible.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { DISTRICTS, DISTRICT_IDS } = require('../config/districts');
const { fetchDailyPrecip } = require('../services/nasaPower');
const hindcast = require('../services/hindcast');
const { loadCore } = require('../engines/phenology');

const CHUNK_YEARS = 5; // bounded response size; POWER serves multi-year ranges slowly

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function fetchDistrictSeries(id, startYear, endYear) {
  const district = DISTRICTS[id];
  const precipByDate = new Map();
  let chunks = 0;
  let gaps = 0;

  for (let year = startYear - 1; year <= endYear; year += CHUNK_YEARS) {
    // One extra year at the front: the first scanned date needs a trailing 30-day
    // window, and a Rabi season-year opens in December of the year before.
    const from = Math.max(1981, year);
    const to = Math.min(endYear, year + CHUNK_YEARS - 1);
    if (from > to) continue;
    const { dates, precipMm } = await fetchDailyPrecip(
      { lat: district.lat, lon: district.lon },
      `${from}0101`,
      `${to}1231`,
    );
    let localGaps = 0;
    for (let i = 0; i < dates.length; i++) {
      const isoDate = `${dates[i].slice(0, 4)}-${dates[i].slice(4, 6)}-${dates[i].slice(6, 8)}`;
      const value = precipMm[i];
      if (value === null) localGaps += 1;
      precipByDate.set(isoDate, value);
    }
    gaps += localGaps;
    chunks += 1;
    process.stdout.write(`    ${from}-${to}: ${dates.length} days${localGaps ? ` (${localGaps} gaps)` : ''}\n`);
  }

  return { precipByDate, chunks, gaps };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const years = Number(args.years) || hindcast.DEFAULT_END_YEAR - hindcast.DEFAULT_START_YEAR + 1;
  const endYear = args.end
    ? Number(args.end)
    : new Date().getUTCFullYear() - 1; // last completed year: a partial year would bias every season
  const startYear = endYear - years + 1;

  process.stdout.write(`Hindcast ${startYear}-${endYear} (${years} season-years)\n`);

  const core = await loadCore();
  const dailyByDistrict = new Map();
  for (const id of DISTRICT_IDS) {
    process.stdout.write(`  ${id}\n`);
    const { precipByDate, chunks, gaps } = await fetchDistrictSeries(id, startYear, endYear);
    process.stdout.write(`    total ${precipByDate.size} days from ${chunks} chunks, ${gaps} gaps\n`);
    dailyByDistrict.set(id, precipByDate);
  }

  const snapshot = hindcast.runHindcast(core, {
    startYear, endYear, dailyByDistrict, generatedAt: new Date().toISOString(),
  });

  for (const id of DISTRICT_IDS) {
    const d = snapshot.districts[id];
    process.stdout.write(
      `  ${id.padEnd(10)} seasons ${String(d.seasonsEvaluated).padStart(2)} · trigger ${String(d.triggerFrequency).padStart(5)}%`
      + ` · band ${JSON.stringify(d.triggerBand)} · cumulative ₹${d.cumulativePayoutPerHectare}\n`,
    );
  }

  fs.writeFileSync(hindcast.SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${path.relative(process.cwd(), hindcast.SNAPSHOT_PATH)} at ${snapshot.generatedAt}\n`);
}

main().catch((err) => {
  process.stderr.write(`run-hindcast failed: ${err.message}\n`);
  process.exitCode = 1;
});
