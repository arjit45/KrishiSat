# KrishiSat — parametric crop-insurance decision support

A parametric agricultural-insurance decision-support platform for Indian
smallholder farming cooperatives. It converts freely available weather and soil data
into a transparent, deterministic drought-severity index and a tiered payout
recommendation that contains no human discretion.

**Status.** Demo / decision-support only. All payout figures are recommendations; there are
no real transactions, no premiums, and no smart contracts (PRD §3.3, §P5).

---

## What it does

- One screen answers, in seconds and with full traceability: how severe is the drought in
  this district right now, for this season; what crop stage is the district in; is a payout
  trigger met, at which tier, for how much per hectare; and why — the complete calculation
  chain and the quality of each data source (PRD §3.2, F1–F7).
- Every payout carries a deterministic trigger receipt that any browser can independently
  recompute (F10).
- A historic replay mode replays real archive data so a demo can show a live trigger on any
  day (F14).
- An append-only recommendation log records what the platform recommended and when (F15).

## Stack

- **Backend:** Node + Express (PRD §20.1). The computation core is a single committed
  JavaScript ES module, `backend/core/ks_core.mjs`, shared by the server and the browser.
- **Frontend:** React 19 + Vite + Tailwind CSS (PRD §20.2).
- **External data (all keyless):** Open-Meteo Forecast API, Open-Meteo Archive API, NASA
  POWER Climatology API, NASA POWER Daily API (PRD §13).
- **Persistence (optional, F15 only):** Supabase Postgres, REST Data API, zero-policy RLS
  with a review gate (PRD §15.7, §14.5).

## Repository layout

```
.
├── api/index.js              # Vercel serverless entrypoint — MUST NOT call app.listen()
├── backend/
│   ├── server.js             # Express app — local dev server and deployed handler
│   ├── core/ks_core.mjs      # the single deterministic core (PRD §14.2)
│   ├── engines/              # deficitEngine, phenology, climateCache
│   ├── services/             # openMeteo, nasaPower, hindcast, recommendationLog, ledger
│   ├── config/               # districts, members, climate-baseline.json, hindcast.json,
│   │                         #   scenarios.json
│   ├── middleware/           # validate, rateLimit, security
│   ├── test/                 # node:test suites (core, engine, api, scenario)
│   └── scripts/              # fetch-baseline, run-hindcast (build-time only)
├── frontend/                 # React + Vite + Tailwind
├── docs/PRD.md               # source of truth — any code contradiction is a defect
├── vercel.json               # API rewrite + SPA fallback + /ks_core.mjs Content-Type + cron
├── package.json              # root manifest — Vercel resolves function deps here (PRD §21.2)
└── .env.example              # template only — no real values ever committed
```

**One registry.** District parameters live in `backend/config/districts.js` and nowhere else
(PRD §11.1, §20.1).

**One core.** `ks_core.mjs` is the core. No second implementation may exist anywhere
(PRD §14.4). The frontend never bundles its own copy — it imports the module served by the
API at `GET /ks_core.mjs` (PRD §20.1).

**Two manifests, kept in step.** `backend/package.json` is the local-dev manifest.
`package.json` at the repository root is the deployed manifest — Vercel resolves a
serverless function's dependencies from the project root. A dependency added to only one of
them is a defect (PRD §20.1).

## Prerequisites

- Node.js (the version pinned in each `package.json`).
- Git.
- For F15 only: a Supabase project (Mumbai / `ap-south-1`) with the single migration in
  `db/migrations/0001_recommendation_log.sql` applied, and the REST Data API enabled
  (PRD §14.5, §21.2).

## Ports

| Half | Command | Default port |
| --- | --- | --- |
| API | `npm run dev:api` (from root) or `node backend/server.js` (from `backend/`) | 5000 (`PORT`) |
| Frontend | `npm run dev:web` (from root) | 5173 (Vite default) |

The API serves `GET /ks_core.mjs` from `backend/core/` with
`Content-Type: text/javascript` (PRD §20.1, §21.2). The frontend calls the API through
`VITE_API_URL` — same-origin in production, `http://localhost:5000` in local development
by default (PRD §21.1).

## How to run both halves

```bash
# install everything
npm install            # root — also installs the API's deployed deps for Vercel
npm --prefix backend install
npm --prefix frontend install

# terminal 1 — API
npm run dev:api        # or: cd backend && node server.js

# terminal 2 — frontend
npm run dev:web        # or: cd frontend && npm run dev
```

Open the frontend URL. The dashboard loads the active district (Jalna by default),
picks Kharif when no season is selected, and refreshes the active district every 30 minutes
while the app is open (PRD §19.5). Auto-refresh is suspended while a scenario is active.

With no Supabase credentials configured, the recommendation log and the F15 history endpoint
gracefully report no history rather than erroring (PRD §16.2, §19.4).

## How to rebuild the core

There is nothing to rebuild. The core is committed JavaScript (PRD §1.4, §21.2): changing a
threshold or a formula is a code change reviewed against `docs/PRD.md`, not a compilation
step. `coreChecksum` in `/api/health` is the SHA-256 of the committed `backend/core/ks_core.mjs`
file itself (PRD §15.8).

If a threshold or formula changes, update `docs/PRD.md` first (bump the version, add a
changelog row), then change the one implementation in `backend/core/ks_core.mjs`
(PRD §1.3, §14.4).

## How to run tests

```bash
cd backend
npm test
```

The suite uses Node's built-in `node:test` (PRD §22). There is no browser test runner —
the frontend is presentational by §14.4, and a browser-oriented runner would only be warranted
if the frontend acquired real logic.

A live smoke test against real Open-Meteo archive data is the acceptance path for F14:
run the API locally, pick a committed scenario from `GET /api/scenarios`, and confirm the
replay returns a real WSI, tier, and duration over real ERA5-Land data (PRD §10.2 F14,
§29).

## Label compliance

The UI labels are locked by PRD §19.2. Forbidden labels include "Orbital Telemetry",
"Satellite Feed", "ORACLE LIVE", "NDVI Vegetation Health Index", "Smart Contract Ledger",
and "Instant Settlement Protocol Active". Required replacements include "Open-Meteo ERA5 +
NASA POWER", "LIVE TELEMETRY", "Crop Water Stress Index (CWSI)", "Demo Settlement Log
(Simulated)", and "Parametric Trigger Engine Active". Soil moisture is dual-sourced and each
source is named for what it is: ERA5-Land reanalysis (historical) and forecast model (current)
(PRD §10.1 F1).

## Deploy readiness

The project is structured for a single Vercel project (PRD §21.2):

- `vercel.json` declares the API rewrite to `/api`, the SPA fallback to `index.html`, the
  `Content-Type: text/javascript` header for `/ks_core.mjs`, and the daily cron job at
  `/api/cron/recommendations`.
- `api/index.js` exports the Express app as a handler; it does not start a listener.
- The root `package.json` is the deployed manifest.
- `.env.example` documents the environment variables. Supabase variables and `CRON_SECRET`
  are server-side only and are never prefixed `VITE_` (PRD §21.1).

**Secrets are not committed.** Before deploying, set the server-side secrets on the hosting
platform — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` — and point
`VITE_API_URL` / `CORS_ORIGINS` at the deployed origin. The recommendation log will not run
without a valid `CRON_SECRET` bearer token (PRD §21.2).

**Cron cadence:** once daily at 06:30 IST (`0 1 * * *` UTC) (PRD §21.2). The job computes
and appends every district for the current season-day and prunes rows past the retention
window (PRD §23.1).

**Region:** Mumbai / `bom1` for the function; Supabase project in `ap-south-1` (PRD §21.2).

**Non-commercial.** The Vercel Hobby plan is non-commercial; any commercial deployment needs
a paid plan and a PRD update (PRD §21.2, §26).

## Limitations & known gaps

- The recommendation log (F15) is the only persisted dataset. Reference data lives in
  committed files (PRD §11.9, §26).
- The hindcast (F11) is precomputed at build time and committed as
  `backend/config/hindcast.json`; computing it per request would exceed a serverless
  execution limit (PRD §9.4, §21.2).
- The hindcast runs on NASA POWER daily precipitation, which carries no soil series, so the
  soil leg of the engine cannot be tested in hindcast mode; duration is always estimated there
  and the OR-clauses are disabled (PRD §11.6).
- Hindi localization is out of scope this version; i18n readiness only (PRD §16.6, §10.3).
- The platform is web-only; there is no mobile app (PRD §10.3).

## Source of truth

`docs/PRD.md` is the single source of truth. Where any code, comment, or earlier draft
contradicts it, the PRD wins and the code is a defect (PRD §1.1).
