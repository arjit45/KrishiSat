# KrishiSat — Product Requirements Document (PRD)

**Document ID:** KS-PRD-001
**Version:** 1.3
**Status:** ACTIVE — Source of Truth
**Owner:** Product
**Applies to:** KrishiSat web platform (backend + frontend + WASM core)
**Last updated:** October 2026

> **Governance rule.** This document is the single source of truth for the product. If a
> requirement, parameter, label, endpoint, or threshold is not defined here, it does not
> belong in the product. Any change to behavior requires a change to this document first,
> which requires a version bump and a changelog entry (§1.3).
>
> **Precedence.** Where any code, comment, ticket, or earlier draft contradicts this
> document, this document wins and the code is a defect.

---

## 1. Metadata, Versioning & Change Control

### 1.1 Version history

| Version | Date | Summary |
| :--- | :--- | :--- |
| 1.0 | Oct 2026 | First complete PRD. Written from scratch as the canonical specification for the whole product. Supersedes the earlier "v2.0 improvement" draft, which covered only deltas and contained internally inconsistent thresholds. |
| 1.1 | Oct 2026 | Review + audit fixes. Adds the §12.7 severity classification, splits `SourceQuality` from `AggregateQuality` (§11.8), publishes both month baselines so the trailing window is independently checkable (§11.2), anchors ledger timestamps, corrects the §18.2 example, discloses the hindcast's data source, specifies the NASA POWER daily endpoint, defines "real" duration, switches the canonical encoding to scaled integers computed inside the core (§10.2 F10, §14.2), standardises core-artifact delivery with a checksum (§15.8), removes cold start via a committed baseline snapshot (§12.4), specifies the member seed (§11.7), and adds F14 Scenario/Replay Mode. Soil moisture is dual-sourced (ERA5-Land reanalysis + forecast model) with both labelled. |
| 1.2 | Oct 2026 | Deployment stack locked: Vercel (single project, serverless) + Supabase. Adds F15 — an append-only, hash-keyed recommendation log (the only persisted dataset), a repository data-access seam (§14.5) ready for future multi-user work, a read-only recommendations endpoint (§18.9), and database/secret/privacy rules (§15.7, §15.10). Replaces in-process cache warming and on-demand hindcast with a scheduled cron job and a build-time committed snapshot — both forced by serverless constraints (§12.4, §21.2). |
| 1.3 | Oct 2026 | **All eleven questions carried in v1.2 are resolved** (§29.4). Facts were verified against primary vendor documentation rather than decided: the NASA POWER daily endpoint, date format, time standard and explicit climatology period (§13.2); Open-Meteo's CC BY 4.0 attribution form and non-commercial free tier (§13.1); the OpenStreetMap ODbL attribution requirement and tile policy (§13.4); the Forecast-API soil-moisture attribution (§10.1 F1, §28); and Supabase's deny-all-with-no-policies rule (§15.7). Decisions recorded: recomputable receipt hash retained and HMAC rejected as a replacement (§15.8); Vitest rejected in favour of `node:test` (§22); two scenarios per district published from a committed catalogue (§10.2 F14); daily cron and 180-day retention with their arithmetic (§21.2, §23.1); Supabase Mumbai, REST Data API access and no pooler (§14.5, §21.2); zero-policy RLS with a review gate (§15.7); and trigger-frequency bands locked as first-hindcast frequency ±15 pp (§22.1, §24). Field capacity and wilting point re-tagged `[SOURCED]` as texture-class typicals (§12.2). |

### 1.2 Status legend

Every normative statement in this document uses one of these markers:

- **MUST** — required for the milestone it belongs to.
- **SHOULD** — strongly recommended; deviation requires a written note.
- **MAY** — optional.

Every locked constant carries a **provenance tag** (§1.4). Every externally sourced claim
carries a citation or is removed (§1.5).

### 1.3 Change control

1. Propose the change (issue or note) referencing the section number.
2. Update this document; bump the version; add a changelog row.
3. Only then change code.
4. A change that alters an endpoint shape, a locked constant, or a threshold is a
   **breaking change** and MUST update the affected acceptance criteria (§29).

### 1.4 Value provenance convention

No number may appear to be more authoritative than it is. Every constant is tagged:

| Tag | Meaning |
| :--- | :--- |
| `[DECIDED]` | A product/design choice made here. Changeable by decision, not by research. |
| `[SOURCED]` | Backed by an external, citable source recorded in this document. |
| `[WORKING]` | A placeholder that is agronomically or statistically plausible but **not yet validated**. MUST be surfaced in the UI's Methodology Notes (§28) as an estimate. |

A `[WORKING]` value MUST NOT be described anywhere in product copy as "research-backed",
"IMD-certified", or "scientific". Doing so violates Design Principle P1.

### 1.5 Statistics citation rule

Any statistic shown to a user, judge, or investor MUST carry a source and a date. If a
figure cannot be sourced, it is removed from product copy and from this document. This
rule exists because a pitch whose numbers can be fact-checked into holes is weaker than a
pitch with fewer, defensible numbers.

> **Verification note.** Several candidate statistics (crop-insurance error rates, claim
> settlement gaps) are intentionally **not** stated as facts in this version until a
> primary source is recorded under §12.6. Product copy MUST NOT invent them meanwhile.

---

## 2. Executive Summary

KrishiSat is a **parametric agricultural insurance decision-support and oracle platform**
for Indian smallholder farming cooperatives. It converts freely available weather and soil
telemetry into a transparent, deterministic drought-severity index and a tiered payout
recommendation that contains no human discretion.

The product is built on four ideas:

1. **Parametric, not adjuster-based.** Payouts follow published formulas, not field
   visits. Identical inputs produce identical recommendations.
2. **Transparent by construction.** Every displayed number exposes its full calculation
   chain and its data provenance.
3. **Deterministic and verifiable.** The computation core is a single C module compiled to
   WebAssembly, executed identically on the server and in the browser, so any user can
   independently reproduce a payout from a published trigger receipt.
4. **Recorded and auditable.** Every recommendation is appended, once and immutably, to a
   persistent log keyed by its input hash (F15) — so the platform can show not only what it
   recommends now, but what it recommended, and when.

KrishiSat is a **decision-support tool**. It is not a licensed insurer, does not collect
premiums, and does not move real money (§3.3).

---

## 3. Product Vision, Aim & Non-Goals

### 3.1 The problem

Indian crop insurance is slow, opaque, and error-prone. Manual claim settlement delays
payouts by months; assessment error rates and a large settlement gap have been reported;
and farmers and cooperatives have no visibility into how a payout decision is reached.
Cooperative officers manage hundreds of farmers and need a fast, defensible read on
drought risk — not a black box.

### 3.2 The aim

Give a cooperative officer, an underwriter, and (indirectly) a farmer a single screen that
answers, in seconds and with full traceability:

- What is the drought severity in this district, right now, for this season?
- What crop growth stage is the district in, and how does that weight the deficit?
- Is a payout trigger met, at which tier, for how much per hectare?
- Why? — the complete calculation chain and the quality of each data source.

### 3.3 Non-goals (this version)

KrishiSat is **NOT**:

- A licensed insurance company, policy issuer, or premium collector.
- A blockchain or Web3 application. No smart contracts, no on-chain settlement.
- A real-time satellite-image processor. No Google Earth Engine, no Sentinel-2 pixel
  extraction, no thermal-infrared canopy temperature.
- A mobility product. Web-only, responsive.
- A mobile app, a land-records system, or a KYC/enrollment platform.
- A production risk-transfer system. All payout figures are recommendations only.

Explicit exclusions are enumerated as Won't-Have in §10.3.

---

## 4. Model Strategy

### 4.1 Parametric, not learned

The drought index and payout logic are **deterministic, formula-based, and fully
auditable**. There is **no machine-learning model and no model training anywhere in the
product.**

Rationale: the entire value proposition rests on reproducibility and the absence of human
or statistical discretion. A learned model would reintroduce opacity, require labeled
ground truth (crop yield or actual claim outcomes) that this project does not have and
cannot obtain without an insurer, and would make "identical inputs → identical output"
unverifiable in practice.

### 4.2 Calibration and validation without labels

Instead of training, the product performs **label-free validation**:

- **Historical hindcast (§10.2, F11)** replays the engine over 10–20 years of reanalysis
  data per district to confirm that trigger frequency and tier distribution are plausible.
- **Monotonicity and bound properties** are asserted in tests (§22): a larger shortfall
  must never lower a tier; a payout must always lie within ₹0–₹50,000/ha.
- **Threshold sensitivity** is reviewed during hindcast to ensure no tier is unreachable
  and no threshold is vacuous.

### 4.3 Machine learning is a Won't-Have

Any learned model — yield prediction, learned vegetation mapping, anomaly detection — is
**out of scope** and listed as such in §10.3. Reintroducing ML requires a new PRD version,
labeled ground-truth data, and a re-examination of the determinism guarantee.

---

## 5. Target Users, Personas & Journeys

### 5.1 Personas

| Persona | Role | Primary need | Success looks like |
| :--- | :--- | :--- | :--- |
| **Rajesh — Cooperative Officer** | Manages 50–500 farmers in one district | Instant district risk level, trigger status, and payout eligibility | Opens the dashboard, sees all four districts at a glance, drills into his district, reads the audit trail, and can defend the number to his members |
| **Meera — Insurance Underwriter** | Evaluates risk before issuing cover | Actuarial payout risk and historical deficit behaviour | Reviews historical trigger frequency, current season risk rating, and illustrative premium indicators |
| **Farmer (via cooperative)** | Needs certainty about payout | Plain-language status of their district and expected settlement | Receives a one-paragraph summary and an accompanying payout estimate |

### 5.2 Core journeys

**J1 — Live assessment.** Rajesh opens KrishiSat → picks Jalna and Kharif → sees severity,
crop stage, WSI, and tier → expands "How was this calculated?" → reads each input and each
step → sees a LIVE data badge → downloads the audit report.

**J2 — Multi-district scan.** Rajesh opens the district risk grid → compares all four
districts at once → clicks the highest-risk district → proceeds as J1.

**J3 — Underwriting review.** Meera opens a district → reviews the actuarial panel and the
historical hindcast → notes trigger frequency and current season rating.

**J4 — Independent verification.** A skeptical reviewer takes a payout's trigger receipt →
opens the verification view → the browser re-runs the identical WASM core on the published
canonical inputs → the recomputed receipt matches the original.

**J5 — Cooperative payout roll-up.** A cooperative officer enters hectares per member (no
KYC) → sees per-member and cooperative-total payout recommendations for the active trigger.

**J6 — Degradation transparency.** An external API is down → the dashboard remains usable →
an amber/red data-quality badge states exactly which input is fallback → the audit trail
marks the fallback line.

---

## 6. Core Design Principles

These are non-negotiable and override convenience.

- **P1 — Scientific honesty.** Every displayed number traces to a real source. No
  fabricated formulas. No hardcoded values shown as real. Any simplified or unvalidated
  computation is labeled as an estimate (`[WORKING]`, §1.4) in the UI.
- **P2 — Transparency by default.** Every payout shows its full chain: input → index →
  threshold → tier. Users can trace exactly why a number was produced.
- **P3 — Graceful degradation.** If an external source fails, the system falls back to a
  documented, defensible value and **clearly marks the affected inputs as fallback**. It
  never silently substitutes a placeholder.
- **P4 — Agronomic-calendar awareness.** Deficit is weighted by crop growth stage. The
  same rainfall shortfall means different things at sowing versus harvest.
- **P5 — No false settlement or blockchain claim.** Any ledger is labeled a **Simulated
  Demo Log**. No real transactions, no smart contracts.
- **P6 — Accurate labels.** Data sources are named exactly as they are. ERA5 Land surface
  model outputs are never called satellite or orbital telemetry.
- **P7 — Determinism.** Given identical canonical inputs, the engine produces a
  bit-identical result and receipt. No randomness, no wall-clock dependence inside the
  computation.
- **P8 — Verifiability.** A payout can be independently recomputed by a third party from
  its published receipt.

---

## 7. Deployment Scope

| Dimension | Value |
| :--- | :--- |
| Districts | 4 — Jalna, Bikaner, Dewas, Anantapur |
| Seasons | Kharif and Rabi |
| Data refresh | On demand + automatic refresh every 30 minutes while the app is open |
| Language | English (Hindi localization is out of scope this version) |
| Clients | Modern desktop and mobile browsers (§16.4) |
| Core | Single C module compiled to WebAssembly, shared by server and browser |
| Hosting | Vercel — one project carrying both the frontend and the serverless API (§21.2) |
| Persistence | Supabase Postgres — append-only recommendation log only (§11.9, F15) |

District parameters (registry) are defined in §11.1.

---

## 8. Glossary

| Term | Meaning |
| :--- | :--- |
| **PMFBY** | Pradhan Mantri Fasal Bima Yojana — India's flagship crop-insurance scheme. |
| **CCE** | Crop Cutting Experiment — the manual yield assessment PMFBY uses. |
| **RWBCIS** | Restructured Weather-Based Crop Insurance Scheme — the parametric precedent for this product's approach. |
| **YES-TECH** | The technology-based yield-estimation approach under PMFBY. |
| **Kharif** | Monsoon-season crop cycle (roughly Jun–Nov). |
| **Rabi** | Winter-season crop cycle (roughly Oct–Apr). |
| **WSI** | Weighted Shortfall Index — rainfall shortfall weighted by crop-stage multiplier. The product's core observable. |
| **CWSI** | Crop Water Stress Index — a soil-moisture-derived stress proxy (0 = no stress, 1 = maximum stress). |
| **Sum insured** | The maximum payout basis per hectare. A representative figure is used here (§12.1). |
| **Scale of Finance** | District/crop-specific cost-of-cultivation basis used to set sums insured under PMFBY. |
| **ERA5 / ERA5-Land** | ECMWF atmospheric and land-surface **reanalysis** products, not live satellite observations. |
| **NASA POWER** | NASA Prediction Of Worldwide Energy Resources — provides free climatology and daily meteorology. |
| **Parametric trigger** | A payout condition based on a measured index crossing a threshold, rather than assessed loss. |
| **Hindcast** | A historical replay of the model over past data. Not a claim-outcome validation. |

---

## 9. System Architecture & Project Flow

### 9.1 Components

```
┌──────────────────────────────── Browser (React + Vite + Tailwind) ─────────────┐
│  Dashboard UI · District grid · Map · CWSI chart · Audit trail · Ledger       │
│  Verification view ── loads the SAME ks_core.wasm for independent recompute   │
└───────────────▲───────────────────────────────────────────────▲───────────────┘
                │ JSON over HTTPS                                │ .wasm
                │                                                │
┌───────────────┴───────────────── Express API (Node) ──────────┴───────────────┐
│  Routes · validation · rate limiting · CORS · security headers                 │
│  Committed baseline + hindcast files   Cron → log append → Supabase (F15)     │
│  Loads ks_core.wasm  ←  the single computation core, shared with the browser   │
└───────────────▲───────────────────────────────────────────────▲───────────────┘
                │                                               │
     ┌──────────┴───────────┐                        ┌──────────┴───────────┐
     │ Open-Meteo Forecast  │                        │ Open-Meteo Archive    │
     │ (current precip,     │                        │ (daily precip + soil  │
     │  soil moisture)      │                        │  moisture, 4+ weeks)  │
     └──────────────────────┘                        └───────────────────────┘
                │
     ┌──────────┴───────────┐
     │ NASA POWER Climatology│  (30-yr monthly precipitation baseline)
     └───────────────────────┘
```

**External sources (four endpoints, all keyless).** Open-Meteo Forecast API, Open-Meteo
Archive API, NASA POWER Climatology API, NASA POWER Daily API.

**One shared store.** The only state that outlives a request is the **append-only
recommendation log** in Supabase Postgres (F15), written by a scheduled job and read on demand
(§11.9, §18.9). Every other input is either computed from the live sources above or read from a
committed file (§12.4).

### 9.2 Single computation core (server + browser)

All index math lives in one C module, `ks_core.wasm` (§14). The server and the browser load
the identical artifact. This is what makes independent verification possible (§10.2, F10)
and prevents server/browser divergence. **No payout math may be reimplemented in
JavaScript or in React** — the frontend renders values, it never derives them.

### 9.3 Live request lifecycle

```
Browser: GET /api/weather/:district?season=kharif|rabi
  │
  ├─ 1. Validate district against the fixed registry (allowlist). Unknown → 404.       §15.2
  ├─ 2. Validate/normalize season. Missing → auto-detect from date.                    §11.2
  ├─ 3. Ensure climatology cache for the district (NASA POWER).                        §12.4
  │       Cache hit → use. Miss → fetch (timeout, capped retry). Fail → fallback.      §12.5
  ├─ 4. In parallel:
  │       • Open-Meteo Forecast → current precip + soil moisture + trailing 30 days
  │         of precipitation (past_days=30) — no reanalysis lag                      §13.1
  │       • Open-Meteo Archive  → daily soil moisture (ERA5-Land) for trend and
  │         duration; last 2–5 days may be missing → splice or truncate and flag     §12.3
  │     Each source independently timed out and validated for null/gap content.        §12.5
  ├─ 5. Normalize into the canonical engine input (§11, §11.7).
  ├─ 6. WASM core, in order:
  │       phenology → deficit (trailing-30d) → soil-moisture deficit → CWSI → duration → tier
  ├─ 7. Compute trigger receipt (canonical hash) over the canonical input.             §10.2 F10
  ├─ 8. Assemble response JSON with per-source SourceQuality (LIVE | FALLBACK) and an   §18
  │     aggregate AggregateQuality (LIVE | PARTIAL | OFFLINE).                        §11.8
  └─ 9. Browser renders grid, chart, audit trail, ledger, summary.
        Verification view MAY re-run ks_core.wasm on the same canonical input.
```

The read path is **side-effect free**: `GET /api/weather` never writes. Recording a
recommendation is done by the scheduled cron job (§9.4, F15), so page views cannot spam the
log, and a read never requires a writable database.

Ordering inside step 6 is fixed: duration depends on the trailing window, and tier depends
on WSI, duration, and crop stage.

### 9.4 Other flows

- **Payout simulation.** Slider change → `POST /api/calculate-payout` with the canonical
  inputs → the same WASM tier function → response. The client never computes tiers (§9.2).
- **Ledger.** Derived from the current computed triggers per district, joined with the
  cooperative member roll-up (§10.2, F7/F12). Deterministic for a given day.
- **Backtest (precomputed at build).** Per district: fetch the NASA POWER daily series, iterate
  season-year windows, run the WASM core per window, aggregate frequency / tiers / cumulative
  payout — then **commit the result** as `backend/config/hindcast.json` (§12.4). The endpoint only
  reads it; computing this per request would exceed a serverless execution limit (§21.2).
- **Recommendation log (F15).** A scheduled cron job computes the current recommendation for each
  district and **appends** it to Supabase, idempotent on the canonical input hash. There is no
  update and no delete path, and the read path never writes (§9.3).
- **Verification.** Receipt → canonical input shown → browser loads `ks_core.wasm` →
  recomputes the hash → matches or flags a mismatch (§10.2, F10).
- **Degradation.** Any external failure → documented fallback value + `FALLBACK` marker on
  that source only → UI badge (§18.3). Partial failures degrade partially, never globally.

### 9.5 Development flow

Phase A (correctness-first core) → gate: engines tested and stable (§22) → Phase B
(validation features + hardening). See §28.

---

## 10. Functional Requirements

Requirements are **MUST** unless marked otherwise. Each has acceptance criteria in §29.

### 10.1 Core engine & dashboard

#### F1 — Real Deficit Engine

**MUST.** Replace any fabricated arithmetic with a scientifically grounded computation
using a real 30-year climatological baseline.

**Baseline.** Per district, fetch NASA POWER 30-year monthly climatological precipitation
(§12.3). Convert the API's mm/day value to monthly millimetres and cache (§12.4).

**Shortfall (trailing 30-day window).** Compare the last 30 days of observed precipitation
against the climatological expectation for those same 30 calendar days:

```
expectedDaily(day)     = monthlyBaselineMm[month(day)] / daysInMonth(day)
expected30             = Σ expectedDaily(day)          for day in trailing 30 days
actual30               = Σ observedPrecipMm(day)        for day in trailing 30 days
rainfallShortfallPct   = clamp( (expected30 − actual30) / expected30 × 100 , 0 , 100 )
```

A trailing window is used deliberately rather than calendar month-to-date: calendar MTD is
unstable at the start of a month (a single rain event on day 1 or 2 swings the ratio
wildly against a tiny denominator). The calendar month-to-date figure is still **displayed**
as a label ("Month-to-date: X mm vs Y mm expected"), but it is not the index driver.

**Soil moisture deficit.**
```
soilMoistureDeficitPct = clamp( (fieldCapacity − soilMoisture) / fieldCapacity × 100 , 0 , 100 )
```

**Weighted Shortfall Index (WSI).** The index used everywhere downstream:
```
WSI = clamp( rainfallShortfallPct × cropStageMultiplier , 0 , 100 )
```

**Source of truth for soil moisture (dual-sourced, both labelled).** Soil moisture comes from
two deliberately different sources, and each MUST be labelled for what it is:

- **Now (current value):** Open-Meteo Forecast API, `soil_moisture_3_to_9cm` (m³/m³). The
  depth-band names (`0_to_1cm`, `1_to_3cm`, `3_to_9cm`, …) are **forecast-model** variables
  (ICON / IFS / GFS). Labelled **"Open-Meteo forecast model (ICON/IFS), 3–9 cm"**.
- **Trailing window (trend and duration):** Open-Meteo Historical/Archive API,
  `soil_moisture_0_to_7cm` (m³/m³), which is **ERA5-Land reanalysis**. Labelled
  **"ERA5-Land reanalysis (0–7 cm)"**.

The two families MUST NOT be conflated: `0_to_7cm / 7_to_28cm / 28_to_100cm / 100_to_255cm`
are reanalysis variables available only from the Archive API; the depth-band names are
forecast-model variables available only from the Forecast API.

**Labeling rule.** Because the current value is a forecast-model output, soil moisture as a
whole MUST NOT be labelled "ERA5 Land Surface Model" without qualification, and MUST NOT be
called satellite, orbital, or telemetry-from-space data. The audit trail names the actual
source of each value. This corrects a labelling defect in earlier drafts (§1.1).

> **Verification closed (v1.3).** Confirmed against the vendor's own forecast documentation:
> `soil_moisture_0_to_1cm … 27_to_81cm` are listed as hourly parameters of the **Weather Forecast
> API**, an endpoint documented as model output stitched from ICON / GFS / IFS and others — not
> reanalysis. The Archive API separately exposes the ERA5-Land bands `0_to_7cm … 100_to_255cm`.
> The label may ship; the source is registered in §12.6.

**Endpoint.** `GET /api/weather/:district` returns the `parametricDeficitEngine` object
(§18.2).

---

#### F2 — Crop Phenology Engine

**MUST.** The engine knows the current crop growth stage from the date and season and
weights the deficit by agronomic importance.

**Single authoritative stage table** (§12.2). The earlier duplicated calendars are replaced
by this one table. There is one table; there is no second, paraphrased copy.

**Function.** `getCropStage(districtId, date, season) → { stageLabel, stageId, multiplier,
month, season, isOffSeason }`. It MUST be pure (no I/O, no clock reads beyond the passed
date) and fully testable.

**Off-season handling.** For months where a season has no defined stage, the engine
returns `stageLabel: "Off-season"`, `multiplier: 1.0`, `isOffSeason: true`. WSI is then the
unweighted shortfall.

**Season selection.**
- User selection (Kharif / Rabi) always wins.
- If unset, auto-detect: **Kharif if the month is Jun–Nov, else Rabi** `[DECIDED]`.
- **Overlap rule.** October and November appear in both calendars (Kharif grain-fill/harvest
  and Rabi sowing). Auto-detection selects **Kharif** in Oct–Nov `[DECIDED]`; a user who
  wants Rabi sowing weights must select Rabi explicitly. The UI shows which season is active
  and its source (auto or user).

**UI.** Displays the current stage and multiplier, e.g. `Flowering & Pollination (1.8× weight)`.

---

#### F3 — Severity → Payout Tier

**MUST.** Payout tiers are keyed on **WSI**, and the drought-duration clauses are made
coherent (the original specification's duration formula made its own thresholds
unreachable; see §12.3).

**Duration source.** Drought duration is computed from real archive data (F11 data / §12.3)
when available. Only when archive data is unavailable is it estimated as
`floor(WSI / 12)` capped at 8, and that estimate is labeled **"Estimated duration
(model-derived)"**.

**Critical coherence rule.** When duration is **estimated** (fallback), the duration
OR-clauses below are **disabled** and tiers are decided on WSI alone. This preserves the
locked WSI thresholds. When duration is **real**, the OR-clauses are active.

**Tier logic (evaluated top-down):**

| Tier | Condition | Payout/ha | % Sum insured |
| :--- | :--- | ---: | ---: |
| TIER 3 — CATASTROPHIC | `WSI ≥ 70` **or** (real duration ≥ 6 wks) | ₹50,000 | 100% |
| TIER 2 — SEVERE | `WSI ≥ 50` **or** (real duration ≥ 4 wks) | ₹37,500 | 75% |
| TIER 1 — MODERATE | `WSI ≥ 35` **or** (real duration ≥ 2 wks) | ₹25,000 | 50% |
| PREVENTED SOWING | `WSI ≥ 25` **and** stage is Pre-sowing/Sowing | ₹12,500 | 25% |
| BELOW THRESHOLD | otherwise | ₹0 | 0% |

**Precedence.** A higher tier always wins. PREVENTED SOWING applies only when no higher
tier is met and the crop stage is Pre-sowing or Sowing.

**Representative sum insured.** ₹50,000/ha `[DECIDED]` is a *representative demo value*. It
MUST be labeled "Representative Sum Insured (demo); actual PMFBY sums insured are crop- and
district-specific via Scale of Finance."

**Endpoint.** `POST /api/calculate-payout` accepts the canonical inputs (§18.3).

---

#### F4 — CWSI Vegetation Proxy

**MUST.** Replace any backwards-derived "NDVI" with a Crop Water Stress Index computed
from real soil moisture.

**Formula (wilting-point banded).**
```
CWSI = clamp( (fieldCapacity − soilMoisture) / (fieldCapacity − wiltingPoint) , 0 , 1 )
```
A banded formula is used instead of `1 − θ/FC` because with a district-specific field
capacity (notably Bikaner's sandy soil, FC = 0.18 `[SOURCED]`, §12.2) the simpler form clamps to
zero after any rainfall and can never register stress, making the index useless there.

**Inputs.** Field capacity and wilting point are per-district (§12.2). Soil moisture is
dual-sourced per F1: ERA5-Land reanalysis from the Archive API for historical points, and
forecast-model soil moisture for the current point.

**Trend.** The 4-week trend is computed from the Archive API's daily ERA5-Land soil-moisture
series (28 days), each day converted to CWSI, plus the current value (forecast model) →
5 points. It is real data, not a hardcoded series. Because the most recent 2–5 days may be
missing from the Archive API (§13.1), those points are either spliced from the Forecast API's
`past_days` values or the trend is truncated — either way the affected points are marked in
the audit trail.

**Chart.** Titled **"Crop Water Stress Index (CWSI) — 4-Week Trend"**, y-axis
**"CWSI (0 = no stress, 1 = max stress)"**, so higher is worse. The chart MUST carry the
label "Derived from ERA5-Land reanalysis soil moisture (historical) and forecast-model soil
moisture (current) — not satellite thermal imagery."

---

#### F5 — Transparent Calculation Audit Trail

**MUST.** A collapsible **"How was this calculated?"** panel showing the full chain:

1. **Data sources** — each named exactly, with LIVE/FALLBACK status and the exact value used.
2. **Calculation chain** — baseline, actual trailing-30-day total, raw shortfall, crop stage
   and multiplier, WSI, duration (with real/estimated marker).
3. **Trigger assessment** — the thresholds, the actual WSI, the resulting tier, the payout
   rate, and data quality.
4. **Receipt** — the trigger receipt ID and a link to the verification view (F10).

Every numeric line in the panel MUST equal the value the engine used (§P2). The panel is the
single most important trust surface in the product.

---

#### F6 — District Risk Grid

**MUST.** A compact grid showing all four districts simultaneously: name + state, zone,
current WSI, severity badge, payout tier, and crop stage. Selecting a district makes it the
active district.

**Reconciliation with F8.** The grid is the **primary selector**. The map (F8) is a
supplementary view; clicking a marker selects the same district. Only one component owns
selection state at a time — the app-level active-district state (§9.3) — so F6 and F8 can
never disagree.

---

#### F7 — Simulated Settlement Ledger

**MUST.** A ledger that is causal, deterministic, and correctly labeled.

- **Causal.** Entries exist only for districts currently meeting a payout trigger; the tier
  and amount match that district's computed tier.
- **Member source (single owner).** Ledger entries are drawn from the F12 member records for
  the district. F12 is the sole authority for member identity, name and area; F7 applies no
  selection rule of its own.
- **Deterministic.** For a given day, scenario and set of triggers the ledger is
  byte-identical across reloads. No `Math.random()`, and no dependence on the wall clock:
  timestamps are anchored to a fixed daily settlement time plus fixed per-entry offsets, so a
  reload at 10:00 and at 15:00 produce identical timestamps.
- **Labeled.** Titled **"Demo Settlement Log — Simulated, not real transactions."**
- **Fields.** `memberRef`, `cooperative`, `tier`, `amount`, `triggerIndex` (e.g.
  `"WSI: 68.9%"`), `cropStage`, `hectares`, `timestamp`.

The ledger MUST NOT be presented as a smart contract or as settled financial transactions.

---

#### F8 — Interactive Map View **(SHOULD)**

**SHOULD.** A Leaflet map of India with the four districts as color-coded risk markers, a
50 km monitoring-radius circle per district, and a popup showing name, state, zone, WSI,
and severity. OpenStreetMap basemap with required attribution (§13.4).

- Uses the already-installed `leaflet` / `react-leaflet`.
- The radius circle uses Leaflet's built-in circle primitive. **`@turf/turf` is not
  required** and MUST NOT be added for this feature.

---

#### F9 — Actuarial Summary Panel **(SHOULD)**

**SHOULD.** Derived entirely from data already fetched (F1 baseline, F11 hindcast):

- Historical trigger frequency / return period per district.
- Current season risk rating: LOW / MEDIUM / HIGH / EXTREME.
- Illustrative premium indicator with a clear "illustrative only" disclaimer.
- Historical average shortfall per district.

No new external API calls. All indicative figures carry the `[WORKING]` / illustrative label.

---

### 10.2 Validation, verification & operational features

#### F10 — Deterministic Trigger Receipt

**MUST.** Every payout response includes a receipt that makes the determinism claim
verifiable.

**Canonicalization (must be reproducible by any party, and is implemented once):**
1. Build an object of exactly the fields in the trigger input (§11.2).
2. Convert **every numeric to a scaled integer** in fixed units — percentages → milli-percent
   (`68.9` → `68900`), millimetres → thousandths, soil-moisture fractions → millionths.
   No floating-point value ever enters the hash path.
3. Serialize as UTF-8 JSON with keys sorted lexicographically and no insignificant whitespace
   (numbers are emitted as JSON integers).
4. Hash with the integer-only SHA-256 implemented in the C core → lowercase hex digest.

Because step 2 leaves no floating point and step 4 has no platform-variant arithmetic, the
digest cannot diverge between the server and the browser. Decimal-format ambiguity — trailing
zeros, negative zero, exponential notation, integer-versus-decimal — is removed by
construction rather than by convention.

**One implementation, not two.** `ks_receipt` in `ks_core.wasm` performs step 3 *and* step 4,
so the canonical string is produced by a single shared implementation (§14.2). If
canonicalisation existed separately in JavaScript and in C, the two could drift and produce a
false MISMATCH or, worse, a false MATCH.

The response includes `receiptId` (the digest), `canonicalEncoding` (`scaled-int-v1`) and
`canonicalInput` so anyone can recompute.

**Verification view.** The browser loads `ks_core.wasm`, recomputes the digest from the
published canonical input, and reports MATCH or MISMATCH. It MUST first assert that the WASM
it loaded matches the `coreChecksum` published by the API (§15.8) — an unasserted match
against a different build would be a false guarantee.

**Authenticity trade-off (documented, and decided).** A recomputable hash proves *integrity
and reproducibility*, not *origin* — anyone can compute a valid hash. **That is accepted
deliberately (v1.3).** An HMAC-signed receipt would require every verifier to hold a server-held
key, which would destroy the very property this feature exists for: that *any* user can
reproduce a payout in their own browser, without trusting or asking us. The recomputable hash
therefore ships, and HMAC is **rejected as a replacement**. If origin authenticity is ever
required, a signature is added as an **additional** field beside the hash — never in place of it
(§15.8, §29.4).

---

#### F11 — Historical Backtest / Replay **(SHOULD)**

**SHOULD.** Replay the engine over 10–20 years of NASA POWER daily data per district.

- For each district and each season-year, run the same WASM core over that window's
  daily data and record the resulting tier and payout.
- Output: trigger frequency, tier distribution, cumulative payout by year, and worst/best
  seasons.
- Cached aggressively (the source data is static) (§12.4) and rate-limited (§15.5).

**Honesty requirement.** The feature MUST be labeled a **hindcast over reanalysis data** —
a methodology sanity check — **not** a validation against actual paid claims. It answers
"does the model behave plausibly across real climate history?" not "did the model predict
real losses?"

---

#### F12 — Cooperative Payout Aggregation

**MUST.** Let a cooperative officer enter hectares per member (no KYC, no land records) and
see payout recommendations.

```
memberPayout   = hectares × tierPayoutPerHectare        (0 if no trigger)
cooperativeSum = Σ memberPayout
```

**Seed data (specified, not left to the implementer).**
- A committed roster at `backend/config/members.js`: **20–30 records per district**
  (~80–120 total), each an `MemberRecord` (§11.7).
- **District-localised names** — Maharashtrian names for Jalna, Rajasthani for Bikaner,
  Madhya-Pradesh names for Dewas, Telugu names for Anantapur. A single global name array
  shared across districts is a defect: a Jalna cooperative must never show a Telugu name.
- **Areas** in the range 0.4–6.0 ha, drawn **deterministically** from a hash of the member
  reference — never `Math.random()`, so the roster and its amounts are stable across reloads
  and machines.
- **Labelled** in the UI as an "illustrative sample of N members".

**Persistence semantics (specified).** Nothing is stored. The server computes **statelessly**:
the roster is the committed file (§11.7), and hectare edits live in **browser state** for the
current session and are re-sent with each recompute (§18.7). A per-instance in-memory store is
explicitly rejected — on a serverless runtime it would lose edits *between requests*, not merely
at restart (§16.3). The UI MUST state "changes are session-only — they reset when you reload"
wherever hectares are editable.

**Single owner.** F12's member records are the sole source for F7's ledger entries.

- Feeds F7 (ledger) so ledger entries correspond to real computed triggers and real member
  areas.

---

#### F13 — Plain-Language Summary & Export

**MUST (summary), SHOULD (export).**

- **Summary.** A rule-based, deterministic paragraph per district, e.g.: *"Jalna is in
  Severe Drought. The weighted shortfall index is 68.9% during the flowering stage
  (1.8× weight). Estimated payout is ₹37,500 per hectare. Data quality: LIVE."* No LLM — an
  LLM would undermine determinism.
- **Export.** A downloadable **CSV** of the audit trail and current assessment, plus a
  print-to-PDF path. A heavy PDF library is **not** required; browser print stylesheet is
  preferred.

---

#### F14 — Scenario / Replay Mode

**MUST.** A user-selectable mode that replays a **real historical drought period**, so the
product can demonstrate a live trigger without fabricating a single number.

- **Data.** Runs the identical engine (§14) over the archived daily series for a chosen past
  period, from the same sources as the live path. Synthetic or hand-tuned inputs are not
  permitted anywhere in a scenario.
- **Selection.** A Live / Scenario control (§19.6). Each scenario names a district and a
  period (e.g. "Jalna — September 2015"), chosen from periods the hindcast (F11) shows as
  triggering. The scenario list is data, not code, so it can change without a release.
- **Labelling.** While a scenario is active a distinct banner states the period and that this
  is a **historic replay over real archive data, not current conditions**. A scenario MUST
  never be presentable as live.
- **Receipt integrity.** `scenarioId` is part of the canonical engine input (§11.2), so a
  scenario receipt can never collide with a live receipt for the same district and date.
- **Interactions.** Auto-refresh is suspended while a scenario is active (§19.5). Returning to
  LIVE restores current conditions and resumes auto-refresh.
- **Ledger and aggregation** follow the active mode and are labelled with the scenario.

**Why this exists.** Without it, a demo on a normal-rainfall day shows four `NORMAL`
districts, no payout and an empty ledger — the product looks broken at precisely the moment it
is working correctly.

**Catalogue (settled, v1.3).** The list is the committed `backend/config/scenarios.json` —
**two scenarios per district, eight total** — being the two highest-WSI windows in which the
hindcast shows a trigger, with `scenarioId` of the form `<district>-<season>-<year>`. Where a
district has fewer than two triggering windows, the gap is filled by its highest-deficit window
and that entry is labelled a **non-trigger**, so a replay that pays nothing is never presented as
though it had triggered. The list MUST NOT be empty for any district: an empty district would
make the demo look broken in exactly the way F14 exists to prevent.

**Endpoints.** `GET /api/scenarios` lists available scenarios;
`GET /api/weather/:district?scenario=<id>` runs one.

---

#### F15 — Recommendation Log (append-only)

**MUST.** Record what the platform recommended, so the record is auditable after the fact.

**What is recorded.** One `RecommendationLogEntry` (§11.9) per district per season-day,
computed by the **scheduled cron job** (§21.2) — never by a page view. The read path is
therefore side-effect free (§9.3), the log cannot be spammed by traffic, and a district's row
is not duplicated once per visitor.

**Append-only, keyed by hash.** The entry's `canonicalInputHash` is `UNIQUE`. The writer
inserts only if absent, so re-running the job for an unchanged input inserts nothing. There is
**no update path and no delete path** in application code: a correction is a new row with a new
date, not an edit of history. That is what makes the log evidence rather than a cache.

**Why the hash, and not just the date.** Two genuinely different recommendations — a district in
two seasons, or live versus scenario — must both be recordable, while the same recommendation
arriving twice must not be. The hash separates exactly those cases, and it is the same digest a
user can recompute (§10.2 F10), so a logged row is independently checkable rather than merely
asserted.

**Scope.** The log stores the recommendation only: the index, tier, payout per hectare,
severity, quality, and the hashes and ids that tie it to a receipt. It stores no member data, no
premiums and no claims (§11.9, §15.10).

**Failure is not fatal.** An unwritable log never blocks a read or a payout calculation; the
entry is retried by the next run, and staleness is surfaced in `/api/health` (§17).

**The log is output, never input.** No requirement in this document may read the log in order to
decide a payout. It records decisions; it does not feed them.

---

### 10.3 Won't-Have (explicitly out of scope)

| Item | Why |
| :--- | :--- |
| Machine learning / any trained model | Reintroduces non-determinism; needs labeled data we cannot obtain (§4). |
| Real blockchain / smart contracts | Requires regulatory sandbox approval; ledger is simulated (§P5). |
| Farm polygon drawing / land records | Requires enrollment, KYC, cadastral data. |
| Sentinel-2 / GEE pixel NDVI extraction | Requires GEE auth and a raster pipeline. |
| Aadhaar / PM-KISAN integration | Requires government API access. |
| Hindi localization | Deferred; i18n readiness only (§16.6). |
| Premium collection / payment gateway | Requires a licensed insurer. |
| Mobile app | Web-only this version. |
| Real claim-outcome validation | Requires an insurer's claims data. |
| Threshold alerting / watchlist | Deferred (selected out of scope for this version). |
| User accounts, login, per-user history | The log is district-level and PII-free; per-farmer recommendations need their own table and a new PRD version (§11.9, §14.5). |
| Editing or deleting a logged recommendation | Append-only is the point; corrections are new rows (F15). |
| A second persisted dataset | Reference data stays in committed files; the log is the only table (§11.9, §26). |

---

## 11. Data Model & Schemas

All shapes are normative. Field names are contract (§18).

### 11.1 District registry

```js
District {
  id: string,            // "jalna" (lowercase, the URL key)
  name: string,          // "Jalna"
  state: string,         // "Maharashtra"
  zone: string,          // "Marathwada"
  agroZone: string,      // "Marathwada Drought-Prone Zone"
  lat: number, lon: number,
  primaryCrops: string[],
  fieldCapacity: number, // m³/m³
  wiltingPoint: number,  // m³/m³
}
```

### 11.2 Canonical engine input (also the receipt payload)

```js
EngineInput {
  districtId: string,
  season: "kharif" | "rabi",
  date: string,                 // ISO yyyy-mm-dd, local to the district
  scenarioId: string | null,    // null = live; else the F14 scenario id
  baselineMonthlyMm: number,    // NASA POWER baseline, CURRENT month
  baselinePrevMonthMm: number,  // NASA POWER baseline, PREVIOUS month (window straddles)
  expected30Mm: number,         // prorated expectation over the trailing 30 days
  actual30Mm: number,           // observed precipitation over the trailing 30 days
  currentSoilMoisture: number,  // m³/m³ — Forecast API (forecast model)
  currentSoilMoistureSource: "forecast_model",
  historicalSoilMoistureSource: "era5_land_reanalysis",
  fieldCapacity: number,        // m³/m³
  wiltingPoint: number,         // m³/m³
  cropStageId: string,
  cropStageMultiplier: number,
  droughtWeeks: number,
  durationIsEstimated: boolean,
}

**Why both month baselines are published.** The trailing 30-day window routinely straddles
two calendar months, so `expected30Mm` cannot be re-derived from the current month's baseline
alone. With `baselinePrevMonthMm` present, a third party can reconstruct `expected30Mm` from
first principles — which is what "independently recomputed" (P8) means in practice. Without
it, a reviewer could re-hash the value but could not check it.
```

### 11.3 Engine output

```js
EngineOutput {
  rainfallShortfallPercentage: number,
  weightedShortfallIndex: number,
  soilMoistureDeficitPercentage: number,
  cwsiProxy: number,
  cwsiTrend: number[],          // 5 points
  droughtDurationWeeks: number,
  durationIsEstimated: boolean,
  isTriggerMet: boolean,
  severityLevel: "NORMAL" | "MODERATE_DEFICIT" | "SEVERE_DROUGHT" | "CATASTROPHIC_DROUGHT" | "PREVENTED_SOWING",
  payoutTier: string,           // "TIER_3_CATASTROPHIC" | ... | "BELOW_THRESHOLD"
  payoutPerHectare: number,
  percentSumInsured: number,
  dataSource: string,
  dataQuality: "LIVE" | "PARTIAL" | "OFFLINE",   // AggregateQuality — see §11.8
}
```

### 11.4 Trigger receipt

```js
Receipt {
  receiptId: string,            // lowercase hex digest
  algorithm: "sha256",
  canonicalEncoding: "scaled-int-v1",
  canonicalInput: string,       // exact canonical JSON serialized (scaled integers)
  createdAt: string,            // ISO timestamp (metadata; NOT part of the hash)
}
```

### 11.5 Ledger entry

```js
LedgerEntry {
  memberRef: string,            // "Ramesh Pawar (MH-COOP-2401)"
  cooperative: string,
  tier: string,
  amount: number,
  triggerIndex: string,         // "WSI: 68.9%"
  cropStage: string,
  hectares: number,
  timestamp: string,            // synthetic, ordered
}
```

### 11.6 Backtest record

```js
BacktestRecord {
  districtId: string,
  year: number,
  season: "kharif" | "rabi",
  peakWsi: number,
  tier: string,
  payoutPerHectare: number,
  durationWeeks: number,
}
BacktestSummary {
  districtId: string,
  years: number,
  triggerFrequency: number,     // seasons that triggered / total seasons
  tierCounts: Record<string, number>,
  cumulativePayoutPerHectare: number,
  records: BacktestRecord[],
}
```

### 11.7 Member / aggregation record

```js
MemberRecord {
  memberRef: string,   // e.g. "MH-COOP-2401"
  name: string,        // illustrative, district-localised; NOT real PII
  cooperative: string,
  districtId: string,
  hectares: number,    // 0.4–6.0 ha, deterministic seed (see F12)
}
```

---

### 11.8 Quality enums

Two distinct enums. They are never conflated, and no field may use one while documenting the
other.

| Enum | Values | Applies to |
| :--- | :--- | :--- |
| **SourceQuality** | `LIVE` or `FALLBACK` | one external source, or one input value |
| **AggregateQuality** | `LIVE`, `PARTIAL`, or `OFFLINE` | a district, the active view, and the header badge |

**Derivation.** Aggregate is `LIVE` when every source is `LIVE`; `PARTIAL` when at least one
source is `FALLBACK` and at least one is `LIVE`; `OFFLINE` when every source is `FALLBACK`.

---

### 11.9 Recommendation log entry (persisted)

The only shape in this document that outlives a request. It is stored in the single Supabase
table (F15) and returned by `GET /api/recommendations` (§18.9).

```json
{
  "id": "uuid",
  "district": "jalna",
  "date": "2026-08-30",
  "season": "kharif",
  "scenarioId": null,
  "wsi": 68.9,
  "payoutTier": 3,
  "payoutPerHectare": 37500,
  "severityLevel": "SEVERE",
  "aggregateQuality": "LIVE",
  "durationMode": "real",
  "canonicalInputHash": "sha256:<hex>",
  "receiptId": "sha256:<hex>",
  "createdAt": "2026-08-30T06:00:12Z"
}
```

| Column | Rule |
| :--- | :--- |
| `district` | One of the four registry keys (§11.1). Never free text. |
| `date` | The recommendation's own season-day, not the run time. |
| `season` | `kharif` or `rabi` (§11.2). |
| `scenarioId` | `null` for live; the scenario key for a replay (§10.2 F14). Part of the hash. |
| `wsi`, `payoutTier`, `payoutPerHectare`, `severityLevel` | The decided values, copied from the engine output (§11.3) — never recomputed here (§12.7). |
| `durationMode` | `real` or `estimated` (§12.3), so a past recommendation's clauses can be read back. |
| `canonicalInputHash` | **`UNIQUE`.** The §10.2 F10 digest of the exact input. Insert-if-absent. |
| `receiptId` | The receipt issued with that recommendation (§11.4), so a row is verifiable exactly as a receipt is. |
| `createdAt` | Run time, server-side, UTC. Informational; never used in a calculation. |

**No personal data.** There is no member field, no requester field, and no IP field (§15.10).
The table is district-level by construction.

**One dataset only.** This is the *only* table in the product. Baselines, hindcast and the
scenario catalogue are committed files, not rows (§9.4, §12.4, §26).

**Multi-user readiness (a documented seam, not built).** If per-farmer recommendations are ever
introduced they get their **own** table and their **own** PRD version; this schema deliberately
carries no identity column, and §14.5 states where such access would live, so nothing here has
to be migrated to accommodate it (§10.3).

---

## 12. Locked Parameters & Algorithms

Every constant is tagged per §1.4. A `[WORKING]` value is a placeholder and MUST be
presented as an estimate in the UI until validated and re-tagged.

### 12.1 Payout sums

| Constant | Value | Tag | Note |
| :--- | ---: | :--- | :--- |
| Representative sum insured | ₹50,000 / ha | `[DECIDED]` | Demo value; label accordingly. |
| Tier 3 payout | ₹50,000 / ha | `[DECIDED]` | 100% |
| Tier 2 payout | ₹37,500 / ha | `[DECIDED]` | 75% |
| Tier 1 payout | ₹25,000 / ha | `[DECIDED]` | 50% |
| Prevented-sowing payout | ₹12,500 / ha | `[DECIDED]` | 25% |

### 12.2 Crop stage, season & district parameters

**Crop-stage multiplier table (single authoritative table).**

| Month | Kharif stage | Kharif × | Rabi stage | Rabi × |
| :---: | :--- | :---: | :--- | :---: |
| Jan | Off-season | 1.0 | Flowering | 1.8 |
| Feb | Off-season | 1.0 | Grain Filling | 1.6 |
| Mar | Off-season | 1.0 | Maturity / Harvest | 0.7 |
| Apr | Off-season | 1.0 | Post-harvest | 1.0 |
| May | Pre-sowing | 1.0 | Pre-sowing | 1.0 |
| Jun | Sowing & Germination | 2.0 | Off-season | 1.0 |
| Jul | Sowing & Germination | 2.0 | Off-season | 1.0 |
| Aug | Vegetative Growth | 1.5 | Off-season | 1.0 |
| Sep | Flowering & Pollination | 1.8 | Off-season | 1.0 |
| Oct | Grain Filling | 1.6 | Sowing | 2.0 |
| Nov | Maturity / Harvest | 0.7 | Sowing & Germination | 2.0 |
| Dec | Post-harvest | 1.0 | Vegetative Growth | 1.5 |

Provenance: multipliers are `[WORKING]` — agronomically plausible and IMD-inspired, but not
yet validated against this product's own hindcast. Stage month assignments are `[DECIDED]`.
Re-tag to `[SOURCED]` only after a citation is recorded in §12.6.

**District parameters.**

| District | Zone | Primary soil | Field capacity (m³/m³) | Wilting point (m³/m³) | Tag |
| :--- | :--- | :--- | :---: | :---: | :--- |
| Jalna | Marathwada drought-prone | Black cotton (Vertisol) | 0.40 | 0.20 | `[SOURCED]` |
| Bikaner | Western arid | Sandy loam (Aridisol) | 0.18 | 0.07 | `[SOURCED]` |
| Dewas | Malwa plateau | Black/red mixed | 0.35 | 0.17 | `[SOURCED]` |
| Anantapur | Rayalaseema semi-arid | Red loam (Alfisol) | 0.28 | 0.14 | `[SOURCED]` |

Field capacity and wilting point are per district and MUST NOT be replaced by a single
global constant.

**Provenance (`[SOURCED]`, v1.3).** These are **texture-class typical values**, not surveyed
values for the district. Each sits inside published ranges for its class — field capacity
≈15–25% for sandy soils, ≈35–45% for loams and ≈45–55% for clays; wilting point from ≈7%
(sandy) to ≈24% (clay). Sources are registered in §12.6. Because they are class typicals
rather than measurements, the hindcast still governs any claim of *district-level* precision:
the tag records where the number came from, not how well it fits Jalna.

### 12.3 Drought duration

**Definition (used when real archive data is available).** A *drought week* is a trailing
7-day window in which:

1. the 7-day precipitation total is below 50% of the 7-day climatological expectation for
   those dates; **and**
2. the mean soil moisture over the window is below 60% of the district's field capacity.

**Input sources for the two legs.** The precipitation leg uses the Forecast API's
`past_days=30` series (the same series as F1's trailing window). The soil-moisture leg uses
the Archive API's ERA5-Land series. Because the two sources have different latencies, the most
recent days of the soil leg may be absent (§13.1).

**Definition of "real" duration.** Duration counts as **real** only when *both* legs are
backed by real data for the entire counted window *and* the window is not truncated by archive
lag or a data gap. If either leg is fallback, if the soil series is spliced for the most
recent days, or if fewer than the counted weeks are actually available, then
`durationIsEstimated = true` — the OR-clauses are disabled and the reported coverage is shown
in the audit trail. Partial coverage MUST NOT be presented as a full count.

Consecutive drought weeks are counted backwards from today inside an 8-week window, and the
count resets to 0 when daily precipitation meets or exceeds the daily climatological
expectation on two consecutive days.

**Fallback.** If the archive series is unavailable, `durationWeeks = min(8, floor(WSI/12))`
and `durationIsEstimated = true`. In this state the duration OR-clauses in §10.1 F3 are
**disabled**; tiers are decided on WSI alone. The UI labels the value "Estimated duration
(model-derived)."

> **Why this rule exists.** A duration figure derived from WSI is not independent evidence;
> using it as an OR-trigger makes tiers fire at lower WSI than the stated thresholds and can
> make the ₹0 band unreachable. Real duration is independent evidence and may validly
> trigger a tier.

### 12.4 Caching

| Cache | Contents | Lifetime | Invalidation |
| :--- | :--- | :--- | :--- |
| Baseline snapshot | **Committed** `backend/config/climate-baseline.json` (with `fetchedAt` + source) | In repo until refreshed | Manual / CI refresh |
| Climate cache | NASA POWER monthly baselines per district, seeded from the snapshot | Process lifetime, **per instance** and best-effort | Never (static); re-seeded on restart |
| Hindcast snapshot | **Committed** `backend/config/hindcast.json`, precomputed at build (§9.4) | In repo until refreshed | Manual / CI refresh |
| Response cache | Assembled weather responses (optional) | ≤ 30 min, **per instance** | Time-based |

**No cache is a correctness dependency.** On a serverless runtime the process may be recycled
between any two requests (§16.3), so nothing may assume a warm instance. The two immovable
inputs — the 30-year climatology and the hindcast — are **committed files** read from disk; the
instance caches are latency optimisations whose absence is never observable in a response.

**Cold start is designed out.** The 30-year climatology is static, so it is fetched **once at
build time** and committed as `backend/config/climate-baseline.json` with a `fetchedAt`
timestamp and source. The server seeds its cache from that file at startup, so **the very
first request never waits on NASA POWER** and never has to serve a reduced-fidelity fallback.

**No in-process warm-up.** The earlier background refresh is **removed**: a serverless instance
cannot be assumed to outlive the request that started it, so warming one would warm a process
that may never serve another request. The committed snapshot *is* the warm state — it is read
per instance in a few milliseconds, and no request ever waits on NASA POWER for it.

Instead, a **scheduled cron job** (§21.2) periodically recomputes the current recommendation for
each district and appends it to the log (F15). Refreshing the committed baseline file stays a
manual/CI action, because a 30-year average changes at most once a year.

Per-district degradation is unchanged and remains a property of the **response**, not of
process state: if one district's live fetch fails, that district alone is marked `FALLBACK`
(§11.8) and the others are unaffected. Only if the snapshot file itself is missing does the
§12.5 fallback path apply.

### 12.5 Emergency fallback values

Only when NASA POWER is unavailable. These are approximate IMD-published long-term averages
`[WORKING]` and MUST be marked `FALLBACK` wherever used.

| District | Monsoon (Jun–Sep) | Annual |
| :--- | ---: | ---: |
| Jalna | ~695 mm | ~782 mm |
| Bikaner | ~267 mm | ~279 mm |
| Dewas | ~913 mm | ~1010 mm |
| Anantapur | ~554 mm | ~568 mm |

Monthly distribution is derived proportionally from the annual/monsoon totals using a fixed
per-region monthly shape. The exact shape table is a `[WORKING]` calibration item and MUST
be recorded here before implementation locks it.

**One unified fallback strategy.** There is exactly one fallback path (this section). The
distinct "fall back to historical weekly averages" idea from earlier drafts is removed.

### 12.6 Source register

Citations for `[SOURCED]` values live here. Until a statistic is registered, it MUST NOT
appear in product copy (§1.5).

| Value / claim | Source | Date recorded |
| :--- | :--- | :--- |
| NASA POWER climatology endpoint/parameters | NASA POWER docs, `/api/temporal/climatology/` | Oct 2026 |
| Open-Meteo Forecast vs Archive soil-moisture variables | Open-Meteo API docs | Oct 2026 |
| Open-Meteo ERA5 / ERA5-Land archive delay (5 days) and the `past_days` alternative | Open-Meteo Historical Weather API docs | Oct 2026 |
| Open-Meteo Forecast vs Archive soil-moisture variable families (`3_to_9cm` vs `0_to_7cm`) | Open-Meteo API docs | Oct 2026 |
| Forecast-API soil moisture is a **forecast-model** output (not ERA5-Land) | Open-Meteo Weather Forecast API docs — `soil_moisture_*` hourly parameters; the endpoint is documented as model output stitched from ICON / GFS / IFS and others | Oct 2026 |
| NASA POWER **daily** endpoint, parameters, date format, default time standard | NASA POWER docs, `/api/temporal/daily/point` (dates `YYYYMMDD`; defaults to Local Solar Time; data 1981-01-01 → near-real-time) | Oct 2026 |
| NASA POWER climatology accepts an **explicit** period via `start` / `end` | NASA POWER docs, Climatology API (custom climatology, e.g. `start=1991&end=2020`) | Oct 2026 |
| Open-Meteo licence (CC BY 4.0) and the required attribution form | open-meteo.com/en/licence, /en/terms (free tier is non-commercial) | Oct 2026 |
| OpenStreetMap attribution requirement and the ODbL | OSMF Licence/Attribution Guidelines, adopted 2021-06-25 | Oct 2026 |
| RLS with no policies denies every request | Supabase docs, "Connect to your database" | Oct 2026 |
| Serverless should use the Data API, not a direct Postgres connection | Supabase docs, "Which connection method do you use?" | Oct 2026 |
| Vercel Hobby cron frequency — **official sources conflict** | Vercel usage-and-pricing page (once per day) vs. Vercel changelog (any interval, all plans) | Oct 2026 |
| Field capacity / wilting point as texture-class typical values (§12.2) | Published soil-water ranges, e.g. Cornell NRCCA (FC ≈15–25% sandy, ≈35–45% loam, ≈45–55% clay) and Oklahoma State Extension (PWP ≈7% sandy → ≈24% clay) | Oct 2026 |
| Trigger-frequency plausibility bands (§22.1, §24) | **Rule locked in v1.3** — first-hindcast frequency ±15 pp. The per-district number is recorded when the hindcast first runs. | Oct 2026 (rule) |
| *(crop-insurance statistics)* | **not yet registered — must not be quoted** | — |

---

### 12.7 Severity classification (LOCKED)

`severityLevel` is the label the grid, banner and badges display. Its **primary rule** is that
it mirrors the decided payout tier, so the two can never disagree:

| Decided tier (§10.1 F3) | severityLevel | Label shown | Colour |
| :--- | :--- | :--- | :--- |
| `TIER_3_CATASTROPHIC` | `CATASTROPHIC_DROUGHT` | CATASTROPHIC DROUGHT | red |
| `TIER_2_SEVERE` | `SEVERE_DROUGHT` | SEVERE DROUGHT | orange |
| `TIER_1_MODERATE` | `MODERATE_DEFICIT` | MODERATE DEFICIT | amber |
| `PREVENTED_SOWING` | `PREVENTED_SOWING` | PREVENTED SOWING | blue |
| `BELOW_THRESHOLD` | `NORMAL` | NORMAL CONDITIONS | emerald |

**WSI-only default mapping.** When duration is **estimated** — the OR-clauses disabled, so the
tier is decided by WSI alone (§12.3) — the rule above reduces to these WSI bands, which is
what a reader will usually see:

| WSI | severityLevel |
| :--- | :--- |
| `WSI < 35` | `NORMAL` |
| `35 ≤ WSI < 50` | `MODERATE_DEFICIT` |
| `50 ≤ WSI < 70` | `SEVERE_DROUGHT` |
| `WSI ≥ 70` | `CATASTROPHIC_DROUGHT` |
| `WSI ≥ 25` **and** stage is Pre-sowing/Sowing | `PREVENTED_SOWING` |

**Why severity mirrors the tier and not WSI alone.** With **real** duration the OR-clauses can
raise the tier above what WSI alone would give — WSI 40 with 4 real drought weeks is Tier 2,
and WSI 30 with 6 real drought weeks is Tier 3. A WSI-only severity would then report
`MODERATE_DEFICIT` beside a Tier 2 payout and `NORMAL` beside a Tier 3 payout: incoherent in
the UI, and untruthful about the drought. Severity therefore follows the decided tier, and the
audit trail states duration as the reason the tier was raised. (An earlier draft of this
section derived severity from WSI alone; an exhaustive test sweep showed it failed in
real-duration mode, and it was corrected — see §29.3.)

**Properties (asserted by test, §22.1).** The four numeric WSI bands partition 0–100 with no
gap and no overlap; all five labels are reachable; and `severityLevel` equals the mirror of
`payoutTier` for **every** input, in both estimated and real-duration modes. Bands are frozen
by decision (`[DECIDED]`).

---

## 13. Data Sources, Licensing & Attribution

### 13.1 Open-Meteo

- **Forecast API:** current precipitation, current soil moisture (Forecast-API depth-band
  variables, e.g. `soil_moisture_3_to_9cm`), **and the trailing 30 days of precipitation via
  `past_days=30`**. The `past_days` series is the primary source for F1's trailing window.
  Free, no key, ~10,000 requests/day.
- **Archive API:** daily **ERA5-Land soil moisture** (`soil_moisture_0_to_7cm`) for the CWSI
  trend and the duration soil leg. Free, no key.
- **Latency — this is the normal case, not an edge case.** Open-Meteo documents ERA5 and
  ERA5-Land as updating **"daily with a 5-day delay"**, and the vendor itself directs users to
  the Forecast API's `past_days` for recent days. Requesting archive data up to *today*
  therefore returns missing recent days. The gap is covered from `past_days` and the affected
  points are marked.
- **Variable families MUST NOT be mixed up.** `0_to_7cm / 7_to_28cm / 28_to_100cm /
  100_to_255cm` are **reanalysis** variables (Archive API only). `0_to_1cm / 1_to_3cm /
  3_to_9cm / 9_to_27cm / 27_to_81cm` are **forecast-model** variables (Forecast API only).
- **Licence and attribution (`[SOURCED]`, v1.3).** API data are offered under **CC BY 4.0**.
  The vendor requires a link next to any location where its data are displayed; the form it
  gives is `Weather data by Open-Meteo.com` linked to `https://open-meteo.com/`, with a citation
  encouraged. The free tier is for **non-commercial** use up to ~10,000 calls/day — the same
  constraint that already applies to the Vercel Hobby plan (§21.2, §26).
- **Attribution placement.** The link MUST render **next to the data it credits** — the
  dashboard footer and the §28 methodology notes — not merely in a repository file. Data
  attribution is a compliance item, not a footer nicety (§15.10).

### 13.2 NASA POWER

- **Climatology API:** 30-year monthly precipitation baseline per district.
  `GET /api/temporal/climatology/point?parameters=PRECTOTCORR&community=AG&longitude=…&latitude=…&format=JSON`
  `[SOURCED]`.
- **Daily API (`[SOURCED]`, v1.3):** daily precipitation for the F11 hindcast.
  `GET /api/temporal/daily/point?parameters=PRECTOTCORR&community=AG&longitude=…&latitude=…&start=YYYYMMDD&end=YYYYMMDD&format=JSON`.
  Dates are **`YYYYMMDD`** with no separators. The API **defaults to Local Solar Time**, so
  `time-standard=UTC` MUST be passed explicitly — otherwise day boundaries will not align with
  the IST season-day that §11.9 logs, and the same calendar date would mean two different days
  in different parts of the product. Data run from **1981-01-01** to near-real-time. The same
  mm/day unit and ×days conversion applies.
- **Request hygiene.** POWER warns that repeatedly requesting the same relative location may be
  blocked, which is a further reason the hindcast runs **once at build time** and its output is
  committed (§9.4) rather than being refetched on a request path.
- **Units.** `PRECTOTCORR` is returned in **mm/day**; the monthly baseline in millimetres is
  the value × days in the month. This conversion MUST be applied and documented.
- **Period label (`[SOURCED]`, v1.3).** The endpoint's *default* period is not documented, so
  the product **never relies on it**: every climatology request passes an explicit `start` / `end`
  (the API documents custom climatology ranges), the chosen range is stored beside the values in
  `backend/config/climate-baseline.json`, and the UI displays that stored string. A hardcoded
  period anywhere in the UI is a defect; so is depending on an undocumented default.

### 13.3 Grid resolution caveat

NASA POWER point requests snap to a coarse grid cell. This MUST be disclosed in the
Methodology Notes (§28): the baseline is grid-cell-derived, not station-interpolated.

### 13.4 Basemap

OpenStreetMap via Leaflet (settled, v1.3 — see §12.6).

- **Attribution is mandatory and has a required form.** Credit must be to "OpenStreetMap" and
  must make the **ODbL** clear; `© OpenStreetMap contributors` is an accepted form, and the text
  should link to `openstreetmap.org/copyright`. For an interactive map the credit belongs **in a
  corner of the map** (lower-right is traditional), must be legible without the user interacting
  with the map, and if it is collapsed the licence information must stay reachable via, say, an
  "(i)" control or a "Data licences" menu entry. Attribution also appears in §28.
- **Tile source.** The OpenStreetMap standard tile server is governed by a **tile usage policy**
  and is not a suitable production tile source for a deployed product. This demo's volume is
  negligible, but any launch MUST move to an appropriate tile provider or self-hosted tiles —
  recorded here because it would change an external dependency (§14.1).

---

## 14. Technology Stack & the C/WASM Core

### 14.1 Stack

| Layer | Technology |
| :--- | :--- |
| Runtime | Node.js 18+ LTS |
| API | Express 5.x, `cors`, `axios` (existing), `@supabase/supabase-js` — the one database client, imported only by §14.5 |
| Hosting | Vercel — one project serving the static frontend and the serverless API (§21.2) |
| Caching | Per-instance in-memory JS `Map`, best-effort only; the durable inputs are committed files (§12.4) |
| Persistence | Supabase Postgres — **one** append-only table, the recommendation log (§11.9, F15) |
| Frontend | React 19, Vite, Tailwind CSS, Chart.js + react-chartjs-2, lucide-react |
| Map | Leaflet + react-leaflet (existing) |
| Core | C → WebAssembly (§14.2) |
| Client WASM | The same `ks_core.wasm` loaded by the browser for verification |

No dependency may be added without recording it here. Specifically: **`@turf/turf` MUST NOT
be added** (§10.1 F8).

### 14.2 The core module

**Language & build.**

- Pure C, freestanding, built with
  `clang --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export-all -o ks_core.wasm ks_core.c`.
- No libc, no `malloc` requirement beyond a fixed static scratch buffer.
- The compiled `ks_core.wasm` is **committed** to the repo (runtime needs no compiler).
- A `scripts/build-core.sh` documents the exact build command.

**Exports (pointer ABI over shared linear memory; no JSON parsing in JS):**

```c
// Linear memory is exported. Initial 2 pages (128 KiB); maximum 16 pages (1 MiB).
uint32_t ks_version(void);
uint32_t ks_scratch_ptr(void);      // base offset of the static scratch buffer
uint32_t ks_scratch_len(void);      // authoritative buffer size

// Single computation entry point: reads a fixed-layout input struct at inPtr, writes a
// fixed-layout output struct, and returns the output offset (or 0 on error).
uint32_t ks_compute(uint32_t inPtr, uint32_t inLen);

// Canonicalise AND hash, both inside the core, so server and browser share one
// implementation. Writes the canonical byte string at outStrPtr and the 32-byte digest
// at outHashPtr. Returns the canonical length, or 0 on error.
uint32_t ks_receipt(uint32_t inPtr, uint32_t inLen, uint32_t outStrPtr, uint32_t outHashPtr);

uint32_t ks_stage_multiplier(uint32_t month, uint32_t season);   // 1=Kharif, 2=Rabi
uint32_t ks_payout_tier(uint32_t wsiMilliPct, int32_t durationWeeks,
                        uint32_t durationIsEstimated, uint32_t isSowingStage);
```

**Memory contract.** The module is freestanding and never calls `malloc`; callers write
structured input into the exported scratch buffer and pass offsets. `ks_scratch_len()` is
authoritative — a caller MUST reject an input that does not fit rather than overrun it.
Because `WebAssembly.Memory.buffer` **detaches when memory grows**, the JS wrapper MUST
re-create its `Uint8Array` / `DataView` views after any call that can grow memory, and MUST
re-read `ks_scratch_ptr()` if the buffer relocates. Calls are single-threaded; the scratch
buffer is not re-entrant.

**Canonicalisation lives in the core.** The JS layer marshals numbers into the binary input
struct and calls `ks_receipt`, which produces both the canonical bytes and the digest. There
is exactly one implementation of the canonical form and of the hash, shared by the server and
the browser, so they cannot disagree (§10.2 F10). All thresholds and constants live in C or in
one shared constants header, never duplicated in JavaScript.

### 14.3 Determinism rules for the core

1. **No transcendentals.** `sin`, `cos`, `exp`, `log`, `pow` MUST NOT be used — libm
   implementations differ across platforms and would break bit-identical receipts. `sqrt`
   is permitted (a native WASM instruction).
2. **Scaled-integer canonical form.** At the canonicalisation boundary every numeric is
   converted to an integer in fixed units (percentages → milli-percent, mm → thousandths, soil
   moisture → millionths) before hashing, so no floating-point formatting exists in the hash
   path (§10.2 F10). Negative zero, exponential notation and integer-versus-decimal ambiguity
   therefore cannot arise.
3. **No clock, randomness, or I/O** inside the core. Time and randomness (if any) are
   injected by the caller as parameters.
4. **Integer hash.** `ks_receipt_hash` is an integer-only SHA-256, so it is identical on
   every platform.

### 14.4 Frontend responsibility boundary

The frontend **renders** values and MAY call the WASM core **only** to independently
recompute a receipt for verification (F10). It MUST NOT compute indices or tiers for
display; those always come from the API response.

---

### 14.5 Data access seam

**One module may touch the database.** All persistence goes through
`backend/repositories/recommendations.js`. Routes, engines, services and frontend components
MUST NOT import a database client, and no SQL is written outside that module. The engine is pure
(§14.3) and the frontend is presentational (§14.4), so the store is a **leaf**: data flows out
of the engine into it, and nothing flows back.

**Direction of dependency.** The repository exposes `append(entry)` and `list(filter)`; callers
pass and receive plain objects of the §11.9 shape. Keeping the client, the connection string and
the service-role key in one file is what makes §15.7's "one server-side key" rule checkable by
inspection instead of by trust.

**Why a seam at all.** The engine's output must not be able to depend on the store, or
determinism (§14.3) would become a property of the deployment rather than of the computation.
With one leaf module, "the log is output, never input" (F15) is an architectural fact: there is
no import path by which a route could read the log and use it in a calculation.

---

## 15. Security, Privacy & Compliance

### 15.1 Threat model (in brief)

A public, unauthenticated, read-mostly decision-support API with no accounts, no payments,
and no personal data. Primary risks: input abuse/DoS, quota exhaustion, information leakage
via errors, and supply-chain/dependency risk.

### 15.2 Input validation

- `:district` is validated against the fixed registry (allowlist). The value is never
  interpolated into an outbound URL; outbound coordinates come from the registry only
  (SSRF avoidance).
- `season` must be exactly `kharif` or `rabi`.
- POST body schema (numbers bounded, enums enforced, NaN/Infinity rejected):
  `weightedShortfallIndex ∈ [0,100]`, `droughtWeeks ∈ [0,8]`, `cropStage` enum,
  `season` enum, `hectares ∈ [0, 1000]`.
- JSON body size capped: `express.json({ limit: '10kb' })`.
- Invalid district → `404`; invalid body → `400` with a generic message.

### 15.3 CORS

Replace allow-all CORS with an **origin allowlist** from configuration (`CORS_ORIGINS`).
Requests from unlisted origins are rejected.

### 15.4 Transport & headers

- Production is served over HTTPS (behind a reverse proxy). HSTS enabled.
- Security headers: `Content-Security-Policy` (must permit the WASM module and the map tile
  origin), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options:
  DENY`/`frame-ancestors 'none'`, and `Permissions-Policy` where useful.

### 15.5 Abuse & quota protection

- Per-IP rate limiting on public endpoints, throttled harder on the most expensive ones.
  Because rate counters live **per instance** on a serverless runtime (§16.3), a limiter is a
  speed bump, not a guarantee: the authoritative protections are the upstream quotas (§23.2)
  and the fact that no request path fans out to an external API unboundedly. A limiter MUST NOT
  be the only thing standing between a client and a paid quota.
- Aggressive static caching (§12.4) to protect the free Open-Meteo / NASA POWER quotas.
- If a quota is approached, the system degrades to fallback rather than failing (P3).

### 15.6 External-call safety

- Every outbound call has a timeout (e.g. 8 s) and **capped** retries with backoff.
- Responses are validated: a `200` carrying nulls/gaps is a **data** failure, not a success,
  and MUST set that source's `SourceQuality` to `FALLBACK` (§11.8).
- Outbound concurrency is bounded; the backtest does not fan out unboundedly.

### 15.7 Secrets & configuration

- No secrets are committed. `.env` is git-ignored; `.env.example` documents every variable
  with a placeholder and no value.
- Any future credential (e.g. for alerting) is read only from the environment.
- The client never receives a secret; the frontend receives only `VITE_API_URL`. **No
  Supabase key is ever exposed to the client.**
- **Database credentials are server-side only.** `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are platform environment variables read only inside the API
  runtime (§21.1). The service-role key bypasses row-level security, so it MUST NOT appear in
  the frontend bundle, an API response, a log line, or a client-visible error (§15.9).
- **Row-level security is deny-all — concrete posture (`[DECIDED]`, v1.3).** The migration
  enables RLS on the log table and declares **zero policies**, which Supabase documents as
  denying every request. The migration additionally `REVOKE`s all privileges on the table from
  `anon` and `authenticated` and grants them only to `service_role`. RLS is a second line of
  defence, not the primary control — the primary control is that no client key exists at all
  (§21.1).
- **Review gate for any policy.** The migration file is the only place a policy may be declared.
  Because the application never uses the anon key, **any added policy is a defect until it is
  justified**, and adding one requires a PRD version bump (§1.3) rather than a silent migration.

### 15.8 Artifact & receipt integrity

- `ks_core.wasm` is checksummed at load; a mismatch between build-time and load-time hashes
  is a hard failure.
- The API publishes `coreChecksum` in `/api/health` (§18.8). The verification view MUST assert
  that the WASM it loaded hashes to that checksum before it may report MATCH — an unasserted
  match against a different build would be a false guarantee.
- The core artifact is served from a **single** location (the backend, §21.2) and is never
  duplicated into the frontend bundle, so two copies cannot drift.
- Receipt hashing is deterministic and integer-only (§14.3). **Origin authentication is
  decided against, not deferred (v1.3).** An HMAC would require every verifier to hold the
  signing key, which would destroy F10's promise that any user can reproduce a payout in their
  own browser; the recomputable hash therefore ships. If provenance *as well as* verifiability is
  ever required, a signature is added as an **additional** field beside the hash — never in place
  of it (§10.2 F10, §29.4).

### 15.9 Error hygiene & logging

- Client-facing errors are generic; stack traces and internal details never cross the wire.
- Structured server logs record request path, status, latency, and external-source
  up/down — never secrets or full payloads.

### 15.10 Privacy & compliance

- **No real personal data.** Member names, references, and areas are simulated and labeled
  as such. There is no KYC, no Aadhaar, no land records.
- **What the one database actually holds (F15).** The recommendation log records
  **district-level, PII-free** rows only: district, date, season, scenario id, index values,
  tier, payout per hectare, severity, quality, input hash and receipt id (§11.9). It contains
  no member name, no member reference, no telephone number, no location finer than the
  district, and no request metadata. A row answers "what did the platform recommend, for this
  district, on this date" — it is not a record of who asked.
- **Retention and deletion.** Rows are kept for the retention window stated in §23.1 and then
  pruned by the same scheduled job that writes them; because the table is append-only, pruning
  is an operator maintenance action, never a user one. A documented deletion path also exists
  so that a mistaken or test row can be removed deliberately.
- **DPDP gate.** The logged rows are not personal data: they describe a district's
  weather-driven index, not a person. If per-farmer recommendations are ever introduced
  (§11.9), they bring a lawful-basis question, a consent flow, and a purpose limitation that do
  **not** exist today — that is a new PRD version, not a schema tweak (§3.3).
- **DPDP Act** (India's data-protection law) is noted here as the trigger for a formal data
  policy **if** real member data is ever introduced; that would require a new PRD version.
- **Regulatory disclaimers.** The product is a decision-support tool, not a licensed
  insurance product; IRDAI relevance is stated in-product. Any ledger is a simulation.
- **Attribution** obligations (§13) are a compliance item, not an optional footer.

### 15.11 Dependency hygiene

- Pinned versions; `npm audit` clean before release; minimal dependency surface.
- New dependencies require a PRD update (§14.1).

---

## 16. Non-Functional Requirements

### 16.1 Performance budgets

| Metric | Budget |
| :--- | :--- |
| `GET /api/weather/:district`, cache-warm | p95 ≤ 800 ms |
| `POST /api/calculate-payout` | p95 ≤ 150 ms |
| Backtest summary (cached) | p95 ≤ 500 ms |
| Dashboard first contentful paint | ≤ 2.5 s on a mid-tier mobile connection |
| WASM core load | ≤ 100 ms |

### 16.2 Availability & degradation

- Target availability 99% during demo/operational windows.
- The product MUST remain usable with one or both external sources down, degrading to
  fallback with clear markers (§18.3). A total external outage MUST still render the
  dashboard with all inputs marked fallback.
- **The database is never on the critical read path.** `GET /api/weather/:district` and every
  other read endpoint MUST function with Supabase unreachable; only `GET /api/recommendations`
  (§18.9) reports the log as unavailable, and it degrades to an explicit empty-with-reason
  response rather than an error (§19.4). A log outage is a missing history, never a broken
  dashboard.

### 16.3 Scalability

- Stateless HTTP tier so instances scale horizontally without sticky sessions. **Per-instance
  memory is never relied upon**: the runtime may recycle or duplicate an instance between any
  two requests, so no request outcome may depend on state left by an earlier one. Immovable
  inputs are committed files (§12.4); the recommendation log is the only shared state, and it
  is written by the cron job, not by a user request (§9.3).
- There is no heavy request path: the backtest is a **build-time** computation read from a
  committed file (§9.4). It is still rate-limited and MUST NOT be on the critical render path.

### 16.4 Browser & device support

- Latest two versions of Chrome, Edge, Firefox, Safari; responsive down to 360 px width.
- WebAssembly required (baseline in all supported browsers).

### 16.5 Accessibility

- Target WCAG 2.1 AA for text contrast and keyboard operability.
- Severity is encoded by **color and label/icon** (never color alone) — color-blind safe.
- Charts expose their data as an accessible table or `aria-label` summaries.
- Map interactions have a non-map equivalent (the F6 grid).

### 16.6 Internationalization readiness

- English only this version, but all user-facing strings are externalized so Hindi can be
  added without code changes.

---

## 17. Observability & Operations

- **Structured request logging:** path, status, latency, district, data quality.
- **External-dependency monitors:** Open-Meteo and NASA POWER up/down, with failure counts
  and last success time, surfaced in `/api/health`.
- **Health/readiness:** `GET /api/health` reports core version, core checksum, source status,
  and — as a separate block that cannot fail the request — database reachability and the
  timestamp of the **last successful log append** (§18.8).
- **Stalled-log alert.** The recommendation log is the one thing that can fail silently: if its
  last append is older than the cron interval plus a margin, that is an operational alert —
  because the product's "and when" claim (§2) is then quietly untrue. The signal is derived
  from the same health payload; nothing else in the product needs a scheduled watchdog.
- **Error tracking:** server-side capture of unexpected errors with context, secret-free.
- **No PII in logs.**

---

## 18. API Contract

Base URL is configured via `VITE_API_URL` on the client. All responses are JSON. All
percentages are 0–100 numbers; soil-moisture fractions are 0–1.

### 18.1 `GET /api/districts`

Summary of all four districts for the grid/map.

```json
[
  {
    "id": "jalna",
    "name": "Jalna",
    "state": "Maharashtra",
    "zone": "Marathwada",
    "wsi": 68.9,
    "severity": "SEVERE_DROUGHT",
    "payoutTier": "TIER_2_SEVERE",
    "cropStage": "Flowering & Pollination",
    "dataQuality": "LIVE"
  }
]
```

### 18.2 `GET /api/weather/:district?season=kharif|rabi`

```json
{
  "district": {
    "name": "Jalna",
    "state": "Maharashtra",
    "agroZone": "Marathwada Drought-Prone Zone",
    "primaryCrops": ["Cotton", "Soybean", "Sorghum (Jowar)", "Sweet Orange"],
    "lat": 19.8297,
    "lon": 75.88,
    "fieldCapacity": 0.4,
    "wiltingPoint": 0.2
  },
  "season": "kharif",
  "seasonSource": "auto",
  "cropStage": {
    "label": "Flowering & Pollination",
    "stageId": "flowering",
    "multiplier": 1.8,
    "month": "September",
    "isOffSeason": false
  },
  "parametricDeficitEngine": {
    "baselineMonthlyMm": 142.5,
    "expected30Mm": 139.5,
    "actual30Mm": 86.1,
    "monthToDateMm": 87.9,
    "monthToDateExpectedMm": 92.0,
    "rainfallShortfallPercentage": 38.3,
    "cropStageMultiplier": 1.8,
    "weightedShortfallIndex": 68.9,
    "soilMoistureRaw": 0.18,
    "soilMoistureRawSource": "forecast_model",
    "fieldCapacity": 0.4,
    "wiltingPoint": 0.2,
    "soilMoistureDeficitPercentage": 55.0,
    "cwsiProxy": 1.0,
    "cwsiTrend": [0.51, 0.66, 0.79, 0.92, 1.0],
    "droughtDurationWeeks": 5,
    "durationIsEstimated": false,
    "isTriggerMet": true,
    "severityLevel": "SEVERE_DROUGHT",
    "payoutTier": "TIER_2_SEVERE",
    "payoutPerHectare": 37500,
    "percentSumInsured": 75,
    "dataSource": "NASA POWER (30-yr baseline) + Open-Meteo (ERA5-Land reanalysis + forecast model)",
    "dataQuality": "LIVE"
  },
  "receipt": {
    "receiptId": "9f2c…",
    "algorithm": "sha256",
    "canonicalEncoding": "scaled-int-v1",
    "canonicalInput": "{…}",
    "createdAt": "2026-10-07T12:00:00+05:30"
  },
  "methodologyNotes": ["…"]
}
```

### 18.3 `POST /api/calculate-payout`

Request:

```json
{
  "weightedShortfallIndex": 68.9,
  "droughtWeeks": 5,
  "durationIsEstimated": false,
  "cropStage": "flowering",
  "season": "kharif"
}
```

Response:

```json
{ "payoutPerHectare": 37500, "tier": "TIER_2_SEVERE", "tierLabel": "Severe", "percentSumInsured": 75 }
```

### 18.4 `GET /api/ledger`

Array of `LedgerEntry` (§11.5). Only districts currently triggering produce entries;
amounts and tiers match the computed triggers.

### 18.5 `POST /api/verify-receipt`

Request: `{ "receiptId": "…", "canonicalInput": "…" }`
Response: `{ "match": true | false, "recomputedReceiptId": "…" }`
(The browser MAY instead recompute locally with WASM; this endpoint supports server-side
verification.)

### 18.6 `GET /api/backtest/:district?years=20`

Returns `BacktestSummary` (§11.6) **read from the committed build-time snapshot**
(`backend/config/hindcast.json`, §9.4) — it computes nothing on the request path. Rate-limited.

### 18.7 `GET /api/cooperatives/:district` and `POST /api/cooperatives/:district`

Returns member records and recomputes aggregate payouts (§10.2 F12). The server holds **no**
member state: the roster is the committed file (§11.7) and any hectare overrides arrive in the
request, so the same call always yields the same answer (§16.3).

- **Seed.** The roster is the committed `backend/config/members.js` file — 20–30 records per
  district, district-localised names, areas 0.4–6.0 ha drawn deterministically from a hash of
  the member reference (§11.7).
- **Persistence.** None server-side. An in-memory store is not merely lost at restart on a
  serverless runtime — it can be lost between two requests (§16.3), so overrides are held in
  **browser state only** and sent with each recompute. The response is labelled as simulated
  and the UI states "changes are session-only — they reset when you reload".
- **Concurrency.** Single-operator demo; no locking is specified or required.

### 18.8 `GET /api/health`

```json
{
  "status": "ok",
  "ts": 0,
  "coreVersion": "1.1.0",
  "coreChecksum": "sha256:<hex>",
  "apiStatus": { "openMeteo": "UP", "nasaPower": "UP" },
  "instance": { "climateSeeded": true, "note": "best-effort; never a correctness dependency (§12.4)" },
  "log": { "reachable": true, "lastAppendAt": "2026-08-30T06:00:12Z", "stale": false }
}
```

**Layering rule.** The `log` and `instance` blocks are evaluated in their own try/catch and
**cannot** change `status` to a failure: a database that is down must not make the API report
itself unhealthy while every read path still works (§16.2). `status` reflects the API and its
external sources only. The core version stays `1.1.0` here because v1.2 changes the platform and
the documentation, **not** the computation core — the checksum in this payload is the proof.

### 18.9 `GET /api/recommendations`

Read-only. Returns recent `RecommendationLogEntry` rows (§11.9) so the record from F15 can be
inspected in the UI (`RecommendationLog.jsx`, §20.2).

**Query parameters**

| Param | Rule |
| :--- | :--- |
| `district` | Optional; one registry key (§11.1). |
| `from`, `to` | Optional ISO dates; inclusive; `from` ≤ `to`. |
| `limit` | Optional; **default 50, hard cap 200**. Values above the cap are clamped, not rejected. |
| `cursor` | Optional opaque cursor for paging (`createdAt` + `id`). |

**Response:** `{ "entries": [...], "nextCursor": "…" | null, "available": true }`

**Rules.**

- **No write endpoint exists.** The log is written by the cron job only (F15); there is no
  `POST`, `PUT` or `DELETE` for it anywhere in this API, so append-only is not merely a promise
  in the code but an absence in the contract.
- **A missing history is not an error.** If the log is unreachable the response is `200` with
  `"entries": []`, `"available": false` and a reason, and the UI renders the §19.4
  empty-with-reason state. A log outage must never break the dashboard (§16.2).
- **Deterministic ordering.** Newest first, `createdAt` then `id` descending, so paging is stable
  across calls.
- Rate-limited like every other read endpoint (§15.5).

---

## 19. UI/UX Rules

### 19.1 Design system

- Background `#020617`; primary accent `#10b981`; secondary `#2dd4bf`; warning `#f59e0b`;
  danger `#ef4444`.
- Font Inter (system-ui fallback).
- Cards: `bg-slate-900 border border-slate-800`, radius 16px (inner elements 8px).
- All cards include accessible labels; severity always pairs color with text.
- **Severity → colour** (matches §12.7; never colour alone):

| severityLevel | Colour |
| :--- | :--- |
| `NORMAL` | emerald (`#10b981`) |
| `MODERATE_DEFICIT` | amber (`#f59e0b`) |
| `SEVERE_DROUGHT` | orange (`#f97316`) |
| `CATASTROPHIC_DROUGHT` | red (`#ef4444`) |
| `PREVENTED_SOWING` | blue (`#3b82f6`) |

### 19.2 Labeling rules (strict)

| Forbidden label | Required label |
| :--- | :--- |
| "Orbital Telemetry" | "Open-Meteo ERA5 + NASA POWER" |
| "Satellite Feed" | "ERA5-Land reanalysis (historical) / forecast model (current)" |
| "ORACLE LIVE" | "LIVE TELEMETRY" |
| "NDVI Vegetation Health Index" | "Crop Water Stress Index (CWSI)" |
| "Smart Contract Ledger" / "Auto-Settlements" | "Demo Settlement Log (Simulated)" |
| "Instant Settlement Protocol Active" | "Parametric Trigger Engine Active" |

No copy may claim settlement of real money or on-chain execution.

### 19.3 Data-quality indicator

Always visible in the header, one of:

- 🟢 **LIVE DATA** — all sources succeeded.
- 🟡 **PARTIAL — [component] using fallback** — one source failed.
- 🔴 **OFFLINE — all data from fallback** — all sources failed.

Each affected metric card also carries its own fallback marker, and the audit trail marks
the fallback line.

### 19.4 Loading & error states

- Global initial load: full-screen satellite animation (label corrected per §19.2).
- Per-metric independent fetch: skeleton shimmer.
- Payout calculating: existing pulse.
- API failure: error screen with a specific message and retry.
- Invalid district: "District not found."
- Partial failure: render with the appropriate badge (§19.3), never a blank screen.

### 19.5 Auto-refresh

While the app is open, the active district refreshes every 30 minutes; refresh MUST NOT
clobber user-entered form state (e.g. hectares). Auto-refresh is suspended while a scenario
(F14) is active.

### 19.6 Live / Scenario selector

A persistent control beside the season toggle:

- **LIVE** (default) — the dashboard reflects current conditions.
- **SCENARIO — historic replay (real archive data)** — a named past drought period for the
  selected district.

While a scenario is active a distinct banner states the period and that this is a replay over
real archive data, not current conditions; the receipt carries the scenario id (§10.2 F14).

---

## 20. Project Structure

### 20.1 Backend

```
backend/
├── server.js                 # Express app, routes, wiring
├── core/
│   ├── ks_core.wasm         # committed build artifact (§14.2)
│   ├── ks_core.c            # C source
│   ├── constants.h          # thresholds/constants shared by the core
│   └── core.js              # WASM loader + typed wrapper (no math)
├── config/
│   ├── districts.js                 # district registry (§11.1) — the ONLY registry
│   ├── members.js                   # deterministic seeded member roster (§11.7, F12)
│   ├── climate-baseline.json        # committed NASA POWER baselines + fetchedAt (§12.4)
│   ├── hindcast.json                # committed backtest output, precomputed at build (§9.4)
│   └── scenarios.json               # the F14 replay catalogue (data, not code)
├── engines/
│   ├── deficitEngine.js     # orchestrates core calls; assembles EngineOutput
│   ├── phenology.js         # thin wrapper over ks_stage_multiplier
│   └── climateCache.js      # reads the committed snapshot; instance cache is best-effort (§12.4)
├── services/
│   ├── openMeteo.js
│   ├── nasaPower.js
│   ├── hindcast.js          # reads the committed hindcast snapshot (§9.4)
│   ├── recommendationLog.js # cron entrypoint: compute + append (F15); not an HTTP route
│   └── ledger.js
├── repositories/
│   └── recommendations.js   # the ONLY module that imports a database client (§14.5)
├── middleware/
│   ├── validate.js
│   ├── rateLimit.js
│   └── security.js
└── package.json
```

The deployed project also carries, at the repository root:

```
vercel.json                 # API rewrite + SPA fallback + wasm Content-Type + cron (§21.2)
package.json                # root manifest — Vercel resolves a function's dependencies here
api/
└── index.js                # exports the Express handler; MUST NOT call app.listen() (§21.2)
db/
└── migrations/
    └── 0001_recommendation_log.sql  # the single table (§11.9): UNIQUE hash, RLS deny-all
```

**On the duplicate manifest.** The root `package.json` repeats the API runtime dependencies
(`express`, `cors`, `axios`, `@supabase/supabase-js`) that `backend/package.json` already
declares, because Vercel resolves a serverless function's dependencies from the **project root**
manifest. The root file is the deployed manifest and `backend/package.json` is the local-dev
one; they must be kept in step, and a dependency added to only one of them is a defect. This is
recorded rather than hidden so the duplication is not mistaken for drift later.

**Path resolution.** The earlier `engines/districts.js` vs `config/districts.js` conflict is
resolved: the registry lives at `backend/config/districts.js`. There is exactly one registry.

**Core artifact route.** `server.js` serves `GET /ks_core.wasm` from `backend/core/` with
`Content-Type: application/wasm`, and the frontend fetches it from `VITE_API_URL`. This single
served location is what the checksum in `/api/health` attests to (§15.8). There is no second
copy under `frontend/`.

### 20.2 Frontend

```
frontend/src/
├── main.jsx
├── index.css
├── App.jsx                   # layout + app-level state (active district, season)
├── components/
│   ├── Header.jsx            # brand + data-quality badge
│   ├── DistrictGrid.jsx      # F6 — primary selector
│   ├── MapView.jsx           # F8 — supplementary selector
│   ├── SeverityBanner.jsx
│   ├── MetricCards.jsx
│   ├── CWSIChart.jsx         # F4
│   ├── AuditTrail.jsx        # F5
│   ├── ReceiptVerify.jsx     # F10
│   ├── BacktestPanel.jsx     # F11
│   ├── PayoutEngine.jsx
│   ├── CooperativePanel.jsx  # F12
│   ├── PlainSummary.jsx      # F13
│   ├── ScenarioPanel.jsx     # F14 — live/scenario selector
│   ├── LedgerPanel.jsx       # F7
│   ├── RecommendationLog.jsx # F15 — read-only history from §18.9
│   └── MethodologyNotes.jsx  # §28 disclosures
├── lib/
│   ├── coreClient.js         # loads ks_core.wasm for verification only
│   ├── formatters.js         # fmtINR, fmtPct, fmtWks, safeNum (presentational only)
│   └── api.js                # fetch wrappers against VITE_API_URL
└── constants/
    └── severity.js           # severity color/label maps ONLY — no thresholds
```

**Boundary rule.** `constants/severity.js` holds display mapping only. Thresholds and tier
logic exist once, in the core/backend. The frontend MUST NOT re-derive tiers.

---

## 21. Deployment & Configuration

### 21.1 Environment variables

| Variable | Where | Purpose |
| :--- | :--- | :--- |
| `VITE_API_URL` | frontend build | Base URL of the API (same-origin in production) |
| `PORT` | API runtime (local only) | API port (default 5000) |
| `CORS_ORIGINS` | API runtime | Comma-separated origin allowlist |
| `LOG_LEVEL` | API runtime | Logging verbosity |
| `SUPABASE_URL` | API runtime **only** | Supabase project URL (§14.5) |
| `SUPABASE_SERVICE_ROLE_KEY` | API runtime **only** | Server-side key for the log; bypasses RLS — never sent to a client (§15.7) |
| `CRON_SECRET` | API runtime + cron declaration | Bearer token the scheduled job must present (§21.2) |

No secret has a value committed anywhere. `.env.example` ships with placeholders. The two
Supabase variables and `CRON_SECRET` are **server-side only** and MUST NOT be prefixed `VITE_`:
a `VITE_`-prefixed variable is inlined into the browser bundle, which would publish the
service-role key to every visitor.

### 21.2 Running

- **Local, both halves:** `npm install && npm start` in `backend/` (serves the committed
  `.wasm`; no compiler needed) and `npm install && npm run dev` in `frontend/`.
- The C core is rebuilt only by maintainers via `scripts/build-core.sh`; the build records the
  artifact's SHA-256 into a committed checksum consumed by `/api/health` (§15.8).
- `GET /ks_core.wasm` is served by the API so the browser loads the **same** artifact the
  server computes with. The frontend never bundles its own copy.

**Production — one Vercel project, one origin.** The frontend and the API deploy as a **single
Vercel project**, so the browser calls `/api/...` and `/ks_core.wasm` on its own origin (no CORS
in production, §15.3).

- `vercel.json` declares (a) the API rewrite to the serverless entrypoint, (b) the SPA fallback
  rewrite to `index.html`, and (c) a `Content-Type: application/wasm` header for
  `/ks_core.wasm` — without (c) the browser refuses to instantiate the module, and the whole
  verification feature (F10) silently dies.
- The Express app is **exported as a handler** (`module.exports = app`); it MUST NOT call
  `app.listen()` in the deployed runtime, because the platform owns the listener.
- **No request path performs long computation.** Both heavy jobs are moved off it: the hindcast
  is precomputed at build and committed (§9.4), and the recommendation log is written by a
  **scheduled cron job** (F15), declared in `vercel.json` and authorised by a `CRON_SECRET`
  bearer check. A cron invocation MUST be idempotent: re-running it for the same district, date
  and input hash inserts nothing new.
- **Cron cadence: once daily (`[DECIDED]`, v1.3).** One invocation computes and appends every
  district for the current season-day, then prunes rows past the retention window (§23.1). Daily
  is sufficient because the sources update daily and the logged record is a *season-day*, not a
  request (§11.9) — and because the append is idempotent on the input hash, a more frequent
  schedule would be harmless but would add no information. It is also a **single** job, so the
  Hobby limit of two cron jobs is not a constraint.
- **Platform ambiguity, recorded rather than papered over.** Official Vercel sources currently
  conflict on whether Hobby permits sub-daily cron: the usage-and-pricing page states cron jobs
  "can only run once per day", while a changelog entry states any interval is available on all
  plans. The design therefore takes **once per day as the floor and depends on nothing finer**,
  so the discrepancy cannot affect correctness either way. Confirm the actual limit at deploy and
  record it in §12.6; a serverless execution ceiling on cron also reinforces the §21.2 rule that
  no request path performs long computation.
- **Region pinning (`[DECIDED]`, v1.3).** The serverless function is pinned to the **Mumbai**
  region and the Supabase project placed in **`ap-south-1` (Mumbai)**, so the function→database
  hop stays in-region and both sit as close as possible to the Indian users the product serves.
  A cross-region function/database pair would add latency to the one write the product makes,
  for no benefit.
- The **Hobby plan is non-commercial** and this product is a decision-support demo; any
  commercial deployment needs a paid plan and a PRD update (§26).

### 21.3 Documentation

A root README MUST document: prerequisites, ports, how to run both halves, how to rebuild
the core, how to run tests, and the known limitations.

---

## 22. Testing & Verification Strategy

Testing is **Phase A**, not post-hoc — the product's credibility rests on the math. Framework:
Node's built-in `node:test` (no new runtime dependency). **Vitest and Testing Library are decided
against (v1.3):** the engine tests must run against the compiled `ks_core.wasm` in Node (§22.1),
which `node:test` does directly, and the frontend is presentational by §14.4 — a browser-oriented
runner would exist to test formatters. Adopting one later would mean the frontend had acquired
real logic, which is itself a PRD change (§14.4, §29.4).

### 22.1 Layers

1. **Engine unit / characterization tests** — run against the **compiled `ks_core.wasm` loaded
   in Node**, never against a JS reimplementation (a JS mirror is forbidden by §14.4 and would
   test code that is not shipped). Coverage: stage multipliers for all 12 months × both seasons
   (including off-season), shortfall, soil deficit, CWSI (including saturation and drought
   extremes), duration counting and reset, and tier boundaries.
2. **Determinism tests** — identical input yields identical output **and** identical receipt
   hash, across repeated runs and across a fresh WASM instance.
3. **Canonicalisation cross-implementation test** — the canonical byte string for a given input
   is identical when produced on the server and in a browser-like environment, and hashes to
   the same digest. This is the regression test for the float-formatting class of bug
   (§10.2 F10).
4. **Severity / tier coherence test** — for **every** input in both estimated and
   real-duration modes, `severityLevel` equals the §12.7 mirror of `payoutTier` (they never
   disagree); the four numeric WSI bands partition 0–100 with no gap or overlap; all five
   labels are reachable. A WSI-only severity would fail this test in real-duration mode, which
   is precisely why severity mirrors the tier.
5. **Property tests** — monotonicity (a larger shortfall or WSI never lowers the tier);
   payout always within ₹0–₹50,000; CWSI always within `[0,1]`; shortfall within `[0,100]`;
   with estimated duration the OR-clauses never fire.
6. **API / contract tests** — every endpoint returns the documented shape; unknown district
   → 404; invalid body → 400; bounds enforced.
7. **Integration tests with mocked externals** — LIVE, partial-fallback, full-fallback;
   `200`-with-nulls; archive lag (recent days missing); timeouts; scenario mode.
8. **Backtest as a statistical gate** — trigger frequency per district falls within **±15
   percentage points** of the frequency its **first** hindcast measures, recorded in §12.6. In
   v1.3 this band is **reported, not enforced**: it becomes a pass/fail gate only once that
   measured number exists (§29.4). No tier may be unreachable.
9. **Frontend** — component render + key interactions (season toggle updates the stage;
   scenario selector labels correctly; tier display matches the API; correct labels per
   §19.2). *Decision (v1.3):* **no Vitest and no Testing Library.** `node:test` is retained; the
   frontend is presentational by §14.4, so a browser-oriented runner would add a toolchain
   (§15.11) purely to test formatters. Adopting one later would mean the frontend had acquired
   real logic — itself a PRD change.
10. **CI** — run the suite on push; the core build is verified by checksum.

### 22.2 Coverage expectation

Every pure engine function has direct tests for its boundaries (threshold ± ε) and its
degradation path. Every endpoint has at least one contract test.

---

## 23. Retention, Quotas & Emergency Degradation

### 23.1 Retention

- **One dataset is persisted:** the append-only recommendation log (§11.9, F15) —
  district-level and PII-free (§15.10). Nothing else survives a request.
- **Retention: 180 days (`[DECIDED]`, v1.3).** One row per district per day is ≈1,460 rows a
  year, so the window bounds the live table at roughly 720 rows (§29.4). Rows older than the
  window are pruned by the same scheduled job that appends (§21.2), so the table cannot grow
  unbounded, and pruning is idempotent.
- Member/aggregation data is simulated and, if edited, held in the **browser session only**
  (§18.7); it is never persisted.
- Instance caches (climate, response) are in-memory, per instance, and may vanish at any time;
  their absence is never observable in a response (§12.4). The committed baseline and hindcast
  files are the only "warm" inputs.

### 23.2 Free-tier quotas `[WORKING — confirm current limits]`

| API | Stated limit | Notes |
| :--- | :--- | :--- |
| Open-Meteo Forecast | ~10,000 req/day | Cache and rate-limit to stay well under. |
| Open-Meteo Archive | ~10,000 req/day | Backtest cached aggressively. |
| NASA POWER | No stated hard limit | Still bound concurrency and cache. |
| Vercel (Hobby) | Cron on a low fixed frequency; a serverless execution ceiling | The cron is the only scheduled work (§21.2); no request path may approach the ceiling. |
| Supabase (free tier) | Storage and row/egress caps | One small append-only table, pruned to the §23.1 window. |

### 23.3 Degradation ladder

1. All sources up → aggregate `LIVE`; every SourceQuality is `LIVE`.
2. At least one source failed → the affected SourceQuality is `FALLBACK` and the district's
   aggregate quality is `PARTIAL` (§11.8).
3. All sources failed → aggregate `OFFLINE`; all inputs fallback; the dashboard still renders.

Duration OR-clauses are disabled whenever duration is estimated (§12.3).

---

## 24. Success Metrics / KPIs

| Metric | Target |
| :--- | :--- |
| Audit-trail completeness | 100% of displayed numbers traceable to a labelled input |
| Receipt reproducibility | 100% of receipts recompute to the same digest |
| Label compliance | 0 forbidden labels (§19.2) in shipped UI |
| Degradation correctness | 100% of fallback inputs visibly marked |
| Determinism | 0 flaky determinism tests |
| Backtest plausibility | Every district's trigger frequency within **±15 percentage points** of the frequency its **first** hindcast measures, recorded in §12.6. Reported in v1.3; enforced as a gate only once that number exists |

---

## 25. Assumptions, Dependencies, Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| External API schema change | Wrong/absent data | Validate responses; alert on shape drift; fallback |
| Free-tier quota exhaustion | Degradation | Cache, rate-limit, bounded concurrency |
| NASA POWER grid coarseness | Baseline inaccuracy | Disclose in Methodology Notes |
| Archive lag (ERA5-Land 5-day delay — the **normal** case, not an edge case) | CWSI / duration gaps | Take the trailing precipitation window from the Forecast API `past_days=30`; splice or truncate the soil leg and mark duration estimated (§12.3, §13.1) |
| Unvalidated crop-stage multipliers and fallback monthly shape | Misleading precision | `[WORKING]` tags + hindcast calibration (§12.2, §12.5); field capacity and wilting point are `[SOURCED]` as texture-class typicals, not district measurements |
| Hindcast mistaken for claim validation | Overclaiming | Explicit labeling (§10.2 F11) |
| WASM build reproducibility | Receipt mismatch | Checksum artifact; documented build |
| Platform float variance | Non-determinism | No transcendentals; scaled-integer canonical form (§14.3) |
| Regulatory misinterpretation | Compliance risk | Clear "decision-support, not insurer" disclaimers |
| Duplicate WASM copies drifting | A false "verified" receipt | Serve one artifact from the backend; publish and assert `coreChecksum` (§15.8) |
| Scenario output mistaken for live | Misleading payout figure | Scenario id inside the canonical input; distinct banner; receipts cannot collide (§10.2 F14) |
| Supabase unreachable | The log cannot be written | Reads never need it (§16.2); the cron retries; health reports it; the dashboard is unaffected |
| Log stops appending | The "and when" claim becomes silently false | Last-append timestamp in `/api/health`; alert on staleness (§17) |
| Log mutated or back-dated | Audit trail untrustworthy | Append-only table, no update/delete in application code, deny-all RLS (§15.7); a row's hash must recompute from its stored inputs (§11.9) |
| Service-role key leak | Full database compromise | Key is server-side only, never bundled or logged (§15.7); RLS deny-all as a second line; rotate on suspicion |
| Serverless timeout on a heavy path | 504 to the user | No request path performs long computation; heavy work is build-time or cron-only (§21.2) |
| Rate limiter assumed global but is per instance | Quota surprise | Documented as a speed bump; upstream quota + bounded fan-out are the real controls (§15.5) |

---

## 26. Cost & Quota Model

Current external costs are **₹0** — all four external endpoints (Open-Meteo Forecast and Archive, NASA POWER Climatology and Daily) are free and keyless. The product
remains viable only while it respects the free quotas: at scale, un-cached per-request
fetching would exhaust Open-Meteo's daily cap, at which point the system degrades to
fallback. The mitigation is caching (§12.4) and rate limiting (§15.5), not paid upgrades.
Any move to paid tiers requires a PRD update with a cost section.

**Hosting and persistence are ₹0/month too** — with a caveat. One **Vercel Hobby** project
carries both the frontend and the API, and one **Supabase free-tier** Postgres holds a single
small append-only table (§11.9). The Hobby plan is **non-commercial**, so a paid plan is a
prerequisite of any commercial launch, not an optional upgrade. The log's growth is bounded by
design — 4 districts × one row per cron interval, pruned after the §23.1 window — so the free
tier is a consequence of the schema rather than a temporary assumption.

---

## 27. Edge-Case Catalog

| Case | Required behavior |
| :--- | :--- |
| 1st–3rd of the month | Trailing-30-day window keeps the index stable (the reason it exists, §10.1 F1) |
| Month rollover within the window | Per-day expectation uses each day's own month (§F1) |
| Leap year | `daysInMonth(Feb)=29` handled |
| Off-season month for the selected season | `isOffSeason = true`, multiplier 1.0 |
| Season overlap (Oct–Nov) | Auto = Kharif; user Rabi overrides (§F2) |
| District has zero rain in window | Shortfall 100%, clamped |
| Soil saturated (θ ≥ FC) | CWSI 0; soil deficit 0 |
| Bikaner low FC | Wilting-point band prevents CWSI collapse at 0 (§F4) |
| Archive missing recent days (the normal case) | Precip window from Forecast `past_days=30`; soil leg spliced or truncated; duration marked estimated (§12.3) |
| `200` with null values | Treated as a data failure → that source's SourceQuality = `FALLBACK` (§15.6) |
| One source down | Aggregate `PARTIAL`; only that input falls back (§11.8) |
| All sources down | Aggregate `OFFLINE`; dashboard still renders |
| No district triggering | Ledger empty with an explanatory message; `/districts` all `NORMAL`; the F14 scenario selector still allows a real historical replay |
| Duration estimated or partially covered | OR-clauses disabled; coverage shown in the audit trail (§12.3) |
| Scenario active | Computation unchanged; banner shown; scenario id in the receipt; auto-refresh suspended (§19.6) |
| Across-month trailing window | Both month baselines published, so `expected30Mm` is independently checkable (§11.2) |
| Backtest data gap | Skip the affected window; report coverage |

---

## 28. Known Limitations & Methodology Notes (disclosed in UI)

The dashboard MUST include a "Methodology Notes" section stating:

1. **Drought duration** is computed from archive data where available; when unavailable it is
   a model-derived estimate and the corresponding trigger clauses are disabled.
2. **Sum insured** (₹50,000/ha) is a representative demo value; real PMFBY sums are crop- and
   district-specific via Scale of Finance.
3. **CWSI** is derived from soil moisture — ERA5-Land **reanalysis** for historical points and
   a **forecast model** for the current point — not from satellite thermal-infrared canopy
   temperature. The audit trail names which source produced each point.
4. **Precipitation baseline** is grid-cell-derived NASA POWER data, not station-interpolated
   IMD data.
5. **The settlement log is a simulation**; no real financial transactions occur.
6. **This platform is a decision-support tool**, not a licensed insurance product; all payout
   figures are recommendations.
7. **Crop-stage multipliers and soil constants are working values** pending validation, and
   are labeled as estimates where used.
8. **The historical hindcast** replays on NASA POWER daily data while the live view uses
   Open-Meteo: the same methodology over a different reanalysis source. It is a methodology
   sanity check, **not** a validation against real claim outcomes.

---

## 29. Acceptance Checklist, Open Questions & Positioning

### 29.1 Per-feature Definition of Done

A feature is done when all of the following hold:

- Its MUST requirements in §10 are met.
- It has tests (§22) covering boundaries and the degradation path.
- Every number it displays appears in the audit trail with a source and quality mark.
- Its labels comply with §19.2.
- Its endpoint (if any) matches §18.

### 29.2 Product acceptance checklist

- [ ] Select any district and see **real computed** data, not hardcoded numbers.
- [ ] See the current crop stage and why its multiplier matters.
- [ ] Read the full audit trail and independently verify the calculation.
- [ ] Switch Kharif/Rabi and see the numbers change.
- [ ] Use the payout simulator and understand tier logic before and after a trigger.
- [ ] See data quality (LIVE/PARTIAL/OFFLINE) in the header at all times.
- [ ] See ledger entries that correspond to actual computed triggers.
- [ ] Encounter no incorrect label (no "orbital telemetry", "satellite feed", etc.).
- [ ] Reproduce a payout from its trigger receipt.
- [ ] Read the Methodology Notes and understand every limitation.
- [ ] Switch to a scenario and confirm it is unmistakably labelled a historic replay.
- [ ] Confirm the severity badge matches §12.7 for the same WSI as the payout tier.
- [ ] Open the recommendation log and see real past rows, newest first, with no way to edit or delete one.
- [ ] Confirm a repeated cron run for an unchanged district inserts nothing (idempotent on the input hash).
- [ ] Break the database URL and confirm the dashboard still renders while the log panel alone reports itself unavailable.

### 29.3 Pre-delivery verification (performed when this document was written)

- **Threshold reachability:** with estimated duration, every WSI band maps to exactly one
  tier and all five tiers are reachable; with real duration, the OR-clauses can independently
  raise the tier by design (§12.3). **Pass.**
- **Severity / tier coherence:** the §12.7 WSI bands partition 0–100 with no gap or overlap,
  all five labels are reachable, and `severityLevel` mirrors `payoutTier` for every input in
  both duration modes — verified by an exhaustive sweep at 0.1 steps across WSI 0–100.
  **Pass.** The first draft of §12.7 derived severity from WSI alone, which failed that sweep
  in real-duration mode (WSI 30 + 6 weeks produced Tier 3 with a `NORMAL` severity label) and
  was corrected.
- **API facts:** the NASA POWER climatology endpoint/parameters and the Open-Meteo
  Forecast-vs-Archive soil-moisture variable split were confirmed against vendor docs.
  **Pass.** The ERA5 / ERA5-Land **5-day archive delay** and Open-Meteo's own `past_days`
  guidance were confirmed against the Historical Weather API docs. **Pass.** The claim that
  Forecast-API soil moisture is a **forecast-model** output is **confirmed** (v1.3) against the
  Weather Forecast API's own hourly parameter list, which documents that endpoint as ICON / GFS /
  IFS model output rather than reanalysis. **Pass.**
- **Statistics:** no crop-insurance statistic is asserted as fact until registered in §12.6.
  **Pass (enforced by rule).**
- **Deployment coherence (v1.2):** no section still describes a correctness dependency on a warm
  in-process cache, an on-demand hindcast, or a global rate counter; exactly one module is
  permitted to import a database client (§14.5); the append-only table is the only persisted
  dataset and carries no identity column (§11.9); and the engine, tier and severity logic was
  **not touched** by this revision — the §12.7 coherence sweep was re-run after these edits and
  remained **Pass**. **Pass.**
- **Open-question resolution (v1.3):** all eleven questions carried from v1.2 were closed (§29.4).
  Six were settled by **verification against primary vendor documentation** — the NASA POWER
  daily endpoint, date format, default time standard and explicit climatology period; the
  Open-Meteo licence and required attribution form; the OpenStreetMap attribution requirement and
  tile policy; the Forecast-API soil-moisture attribution; and Supabase's
  RLS-with-no-policies rule. Five were settled by **decision**, each recorded where it is
  normative. Two items remain deliberately open because they need measurement rather than
  judgement: the crop-stage multipliers and the fallback monthly shape, and the per-district
  trigger-frequency numbers whose *rule* is locked. **Pass**, with those two exceptions stated
  rather than implied.

### 29.4 Questions carried from v1.2, resolved in v1.3

All eleven questions below are **settled**. Each row states the decision and where it is now
normative. Six were resolved by verification against primary vendor documentation; five by a
recorded decision. The original wording is retained at the end of this section for traceability.

| # | Question | Resolution | Where |
| :--- | :--- | :--- | :--- |
| 1 | Receipt authenticity: recomputable hash vs HMAC | **Recomputable hash ships; HMAC rejected as a replacement.** A verifier cannot check an HMAC without the signing key, which would destroy F10's promise that any user can reproduce a payout in their own browser. If provenance is ever needed it is added as an *additional* field beside the hash, never in place of it. | §10.2 F10, §15.8 |
| 2 | Add Vitest + Testing Library? | **No.** `node:test` is retained. Engine tests must run against the compiled WASM in Node, which `node:test` does directly; the frontend is presentational (§14.4), so a browser runner would test formatters and add a toolchain (§15.11). | §22, §22.1 |
| 3 | NASA POWER climatology period + daily endpoint | **Both settled by verification.** Daily: `/api/temporal/daily/point`, dates `YYYYMMDD`, **defaults to Local Solar Time** so `time-standard=UTC` must be passed, data from 1981-01-01. The period is never assumed: every request passes an explicit `start`/`end` and the UI shows that stored string. | §13.2, §12.6 |
| 4 | Open-Meteo / OSM licence and attribution wording | **Settled by verification.** Open-Meteo: CC BY 4.0 with the vendor's own form `Weather data by Open-Meteo.com` linked and placed *next to* the data; the free tier is non-commercial. OSM: credit "OpenStreetMap", make the ODbL clear, `© OpenStreetMap contributors` accepted, in a corner of the map; the standard tile server is not a production tile source. | §13.1, §13.4 |
| 5 | The `[WORKING]` calibration values | **Partly settled.** Field capacity and wilting point are **re-tagged `[SOURCED]`** as texture-class typicals — all four sit inside published ranges for their class — and registered. The crop-stage multipliers and the fallback monthly shape stay `[WORKING]`: no citation supports them, so the hindcast still gates them. | §12.2, §12.5, §12.6 |

| 6 | Is Forecast-API soil moisture a forecast-model output? | **Confirmed.** `soil_moisture_0_to_1cm … 27_to_81cm` are hourly parameters of the **Weather Forecast API**, documented as model output stitched from ICON / GFS / IFS and others; the Archive API separately exposes the ERA5-Land bands `0_to_7cm … 100_to_255cm`. The dual-source labels may ship. | §10.1 F1, §13.1, §28 |
| 7 | Trigger-frequency plausibility bands | **Rule locked; the numbers need the hindcast.** A district's band is its first-hindcast trigger frequency **±15 pp**, clamped to 0–100. Until that frequency is recorded in §12.6 the band is **reported, not enforced** as a gate. | §22.1, §24, §12.6 |
| 8 | Which scenarios F14 offers, and where | **Settled.** The committed `backend/config/scenarios.json` holds **two per district, eight total**, taken from the highest-WSI triggering windows; where a district has fewer than two, its highest-deficit window fills the gap and is labelled a non-trigger, so a replay that pays nothing is never presented as a trigger. | §10.2 F14 |
| 9 | Supabase region + serverless connection strategy | **Settled.** Access is via the **REST Data API** through `@supabase/supabase-js` — HTTPS only, holding no Postgres connection — so there is no pool to exhaust and **no pooler is configured**; a wire-protocol client is already foreclosed by §14.5. Project in **Mumbai (`ap-south-1`)**, function co-located. | §14.5, §21.2 |
| 10 | Cron cadence + retention window | **Settled.** **Once daily** — the floor the design assumes — and **180 days**. Sources update daily and the logged record is a season-day, so a finer cadence adds rows without information; the append is idempotent, so more frequent is harmless. ≈1,460 rows/year, ≈720 live at any time (180 days × 4 districts). | §21.2, §23.1 |
| 11 | RLS posture in the migration | **Settled.** RLS enabled with **zero policies** (Supabase documents this as denying every request), plus `REVOKE` from `anon`/`authenticated` and a grant only to `service_role`. The migration is the only place a policy may live, and adding one requires a version bump. | §15.7 |

**Deliberately left open — these need measurement, not a decision.** Two things cannot be closed
by judgement, and closing them by assertion would be exactly the unearned certainty this document
exists to prevent:

- **Crop-stage multipliers** and the **fallback monthly shape** — unvalidated; gated on the first
  hindcast, and re-taggable only once a source is registered (§12.2, §12.5, §12.6).
- **Per-district trigger-frequency numbers** — the band *rule* is locked above; each district's
  measured frequency is written to §12.6 when the hindcast first runs.

**One platform ambiguity, recorded rather than resolved.** Official Vercel sources currently
disagree about the Hobby plan's cron frequency (the usage-and-pricing page says once per day; a
changelog entry says any interval, on all plans). The design assumes **once per day as its floor
and depends on nothing finer**, so the discrepancy cannot affect correctness either way. Confirm
at deploy and register the answer in §12.6.

**The eleven questions as originally worded are retained below for traceability.**

1. Final receipt authenticity model: recomputable hash (current) vs HMAC-signed extension.
2. Whether to add Vitest + Testing Library for frontend tests (§22.1).
3. Exact NASA POWER climatology **period** string, and the exact **daily** endpoint shape
   (§13.2).
4. Exact Open-Meteo / OSM **license/attribution** wording as currently published (§13).
5. The `[WORKING]` calibration values (multipliers, field capacity, wilting point, fallback
   monthly shape) — to be validated by hindcast and re-tagged (§12).
6. **Verify** that Forecast-API soil moisture is a forecast-model output rather than ERA5-Land
   before the labels in §10.1 F1 / §28 ship.
7. The trigger-frequency plausibility bands gated on by §22.1 and §24 — must be derived from
   the first hindcast and recorded before being used as a pass/fail gate.
8. Which scenarios (district + period) the F14 demo list offers, and where it is stored.
9. Supabase **region** (latency to Indian users vs. proximity to the function region) and the
   serverless connection strategy — a pooled connection (Supavisor/pgBouncer) versus a pooled
   HTTP client. To be settled before the first deploy.
10. The cron **cadence** and the retention window (both `[WORKING]`, §21.2 / §23.1). Daily is
    assumed sufficient because the index moves with weather rather than with demand, but the
    cadence must be justified against the log's usefulness before it is treated as final.
11. The exact RLS posture to declare in the migration — deny-all is stated in §15.7, but the
    concrete policy set, and whether changing it needs a review gate, are unset.

### 29.5 Argument positioning

**"How do you guarantee the payout without human interference?"**
KrishiSat implements a parametric trigger architecture. Given identical inputs — NASA POWER
30-year baselines, real-time soil moisture, and crop-stage multipliers — the Weighted
Shortfall Index produces an identical payout recommendation every time. There is no
adjuster, no field visit, and no human variable. Each payout carries a trigger receipt, and
the computation core is a single WebAssembly module that any user can re-run in their own
browser to reproduce the result exactly. That is the literal, testable form of
"deterministic, auditable settlement."

**"What makes this different from PMFBY/YES-TECH?"**
Those are government back-ends that a cooperative officer cannot see or interact with.
KrishiSat is the transparent front-end: a cooperative manager can open it on any device,
understand the drought status and payout logic in real time, verify the math themselves, and
act — rather than waiting months to learn an opaque outcome. The methodology is explicitly
disclosed, including exactly where it is an estimate.

**"How do you know it says today what it said yesterday?"**
Because every recommendation is written to an append-only log, keyed by a hash of its own
inputs, the moment it is made. The platform can show not only what it recommends now, but
**what was recommended, and when** — and any row can be re-derived from its stored inputs
exactly as a receipt can. A record that cannot be quietly edited is the difference between an
audit trail and a screenshot.

---

*End of document — KrishiSat PRD v1.3*
