import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Satellite, RefreshCw, AlertTriangle, CalendarRange } from 'lucide-react';

import { api, fetchLedger } from './lib/api';
import Header from './components/Header';
import DistrictGrid from './components/DistrictGrid';
import MapView from './components/MapView';
import ScenarioPanel from './components/ScenarioPanel';
import SeverityBanner from './components/SeverityBanner';
import MetricCards from './components/MetricCards';
import CWSIChart from './components/CWSIChart';
import AuditTrail from './components/AuditTrail';
import ReceiptVerify from './components/ReceiptVerify';
import PayoutEngine from './components/PayoutEngine';
import LedgerPanel from './components/LedgerPanel';
import CooperativePanel from './components/CooperativePanel';
import RecommendationLog from './components/RecommendationLog';
import PlainSummary from './components/PlainSummary';
import BacktestPanel from './components/BacktestPanel';
import MethodologyNotes from './components/MethodologyNotes';

// ─────────────────────────────────────────────────────────────────────────────
// App — layout and app-level state (§9.3, §20.2).
//
// This file OWNS state: the active district, the season, the active scenario,
// and the fetched payloads. Components receive data and call back; none of them
// fetches or derives a tier. Two rules shape the effects below:
//
//   §19.5 — the active district refreshes every 30 minutes, and MUST NOT clobber
//           user-entered form state; auto-refresh is SUSPENDED while a scenario
//           is active and resumes when LIVE is restored.
//   §19.4 — a failed fetch renders a specific message with retry, and a partial
//           failure renders with its badge rather than a blank screen.
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_MS = 30 * 60 * 1000; // §19.5

function LoadingScreen({ district }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-slate-950" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="relative flex items-center justify-center">
        <div className="absolute w-28 h-28 rounded-full border-2 border-emerald-500/20 animate-spin" style={{ animationDuration: '4s' }} />
        <div className="absolute w-20 h-20 rounded-full border-2 border-teal-400/30 animate-spin" style={{ animationDuration: '2.5s', animationDirection: 'reverse' }} />
        <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-2xl">
          <Satellite className="w-10 h-10 text-emerald-400" />
        </div>
      </div>
      <div className="text-center">
        <h1 className="text-xl font-black text-slate-100 mb-1">Loading the deficit assessment…</h1>
        <p className="text-sm text-slate-400">
          Open-Meteo ERA5 + NASA POWER · <span className="text-emerald-400 font-semibold capitalize">{district}</span>
        </p>
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-slate-950 px-6" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="bg-red-950/40 border border-red-800/50 rounded-2xl p-8 max-w-lg w-full text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-red-300 mb-2">Could not load the assessment</h2>
        <p className="text-sm text-slate-400 mb-2">{message}</p>
        <p className="text-xs text-slate-600 mb-6">
          The API must be running — locally that is <code className="text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded">node server.js</code> in{' '}
          <code className="text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded">backend/</code>
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="px-6 py-3 rounded-xl text-sm font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [district, setDistrict] = useState('jalna');
  const [season, setSeason] = useState('');          // '' = auto (§F2)
  const [scenarioId, setScenarioId] = useState(null);

  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [weatherError, setWeatherError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [districts, setDistricts] = useState(null);
  const [districtsError, setDistrictsError] = useState(null);
  const [scenarios, setScenarios] = useState(null);
  const [scenariosError, setScenariosError] = useState(null);
  const [ledger, setLedger] = useState({ entries: [], label: null, note: null });
  const [ledgerLoading, setLedgerLoading] = useState(true);

  const [coop, setCoop] = useState(null);
  const [coopLoading, setCoopLoading] = useState(true);
  const [coopError, setCoopError] = useState(null);
  const [overrides, setOverrides] = useState({});    // session-only (§16.3, §18.7)

  const [backtest, setBacktest] = useState(null);
  const [backtestError, setBacktestError] = useState(null);
  const [recs, setRecs] = useState(null);
  const [recsError, setRecsError] = useState(null);
  const [health, setHealth] = useState(null);
  const [coords, setCoords] = useState({});

  const overrideTimer = useRef(null);
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  const scenario = weather?.scenario || null;
  const activeScenarioId = scenarioId;

  // ── one-time: catalogue, log history, health ──────────────────────────────
  useEffect(() => {
    api.scenarios()
      .then((data) => setScenarios(data.scenarios || []))
      .catch((err) => setScenariosError(err.message));
    api.recommendations({ limit: 50 })
      .then(setRecs)
      .catch((err) => setRecsError(err.message));
    api.health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  // ── district summaries (live) ─────────────────────────────────────────────
  const loadDistricts = useCallback(() => {
    api.districts(season || undefined)
      .then((data) => { setDistricts(data); setDistrictsError(null); })
      .catch((err) => setDistrictsError(err.message));
  }, [season]);

  useEffect(() => { loadDistricts(); }, [loadDistricts, reloadToken]);

  // ── the active district's assessment (live or replay) ─────────────────────
  const loadWeather = useCallback(() => {
    setWeatherLoading(true);
    setWeatherError(null);
    api.weather(district, { season: season || undefined, scenario: scenarioId || undefined })
      .then((data) => {
        setWeather(data);
        setWeatherError(null);
        if (data.district?.id && typeof data.district.lat === 'number') {
          setCoords((prev) => ({ ...prev, [data.district.id]: { lat: data.district.lat, lon: data.district.lon } }));
        }
      })
      .catch((err) => {
        setWeather(null);
        setWeatherError(err.message);
      })
      .finally(() => setWeatherLoading(false));
  }, [district, season, scenarioId]);

  useEffect(() => { loadWeather(); }, [loadWeather, reloadToken]);

  // ── ledger: all districts live; the scenario's district in replay ─────────
  const loadLedger = useCallback(() => {
    setLedgerLoading(true);
    fetchLedger({ season: season || undefined, scenario: scenarioId || undefined })
      .then(setLedger)
      .catch(() => setLedger({ entries: [], label: null, note: null }))
      .finally(() => setLedgerLoading(false));
  }, [season, scenarioId]);

  useEffect(() => { loadLedger(); }, [loadLedger, reloadToken]);

  // ── cooperative aggregation (session edits are re-sent, never stored) ─────
  const loadCoop = useCallback((postedOverrides) => {
    const query = { season: season || undefined, scenario: scenarioId || undefined };
    const request = Object.keys(postedOverrides).length > 0
      ? api.saveHectares(district, postedOverrides, query)
      : api.cooperatives(district, query);

    setCoopLoading(true);
    request
      .then((data) => { setCoop(data); setCoopError(null); })
      .catch((err) => { setCoopError(err.message); })
      .finally(() => setCoopLoading(false));
  }, [district, season, scenarioId]);

  // Fetch when the subject changes, always with the CURRENT session overrides
  // so an edit is never silently reverted by a re-render (§18.7, §19.5).
  useEffect(() => {
    loadCoop(overridesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCoop, reloadToken]);

  const onOverride = useCallback((memberRef, value) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null || Number.isNaN(value)) delete next[memberRef];
      else next[memberRef] = value;
      return next;
    });
    clearTimeout(overrideTimer.current);
    overrideTimer.current = setTimeout(() => {
      const current = { ...overridesRef.current };
      if (value !== null && !Number.isNaN(value)) current[memberRef] = value;
      else delete current[memberRef];
      loadCoop(current);
    }, 250);
  }, [loadCoop]);

  // ── backtest for the active district ──────────────────────────────────────
  useEffect(() => {
    setBacktest(null);
    setBacktestError(null);
    api.backtest(district)
      .then(setBacktest)
      .catch((err) => setBacktestError(err.message));
  }, [district]);

  // ── map coordinates: read from each district's own payload (one registry) ──
  useEffect(() => {
    if (!districts || districts.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const d of districts) {
        if (cancelled) return;
        if (coords[d.id]) continue;
        try {
          const data = await api.weather(d.id, { season: season || undefined });
          if (cancelled) return;
          if (data.district && typeof data.district.lat === 'number') {
            setCoords((prev) => ({ ...prev, [d.id]: { lat: data.district.lat, lon: data.district.lon } }));
          }
        } catch {
          // a district whose payload never arrives is simply not plotted (F8)
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districts, season]);

  // ── §19.5 auto-refresh: 30 minutes, SUSPENDED while a scenario is active ──
  useEffect(() => {
    if (scenarioId) return undefined;              // replay never self-refreshes
    const timer = setInterval(() => setReloadToken((t) => t + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [scenarioId]);

  // ── view the loading / error guards ──────────────────────────────────────
  if (weatherLoading && !weather && !weatherError) {
    return <LoadingScreen district={district} />;
  }
  if (weatherError && !weather) {
    return <ErrorScreen message={weatherError} onRetry={() => setReloadToken((t) => t + 1)} />;
  }

  const seasonActive = weather?.season || (season === 'rabi' ? 'rabi' : 'kharif');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <Header
        quality={weather?.parametricDeficitEngine?.dataQuality}
        sourceQuality={weather?.sourceQuality}
        scenario={scenario}
        coreVersion={health?.coreVersion}
        health={health}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">

        {/* ── mode row: season toggle (left) + LIVE/SCENARIO control (§19.6) ─ */}
        <section className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Season</p>
            <div className="flex items-center gap-2">
              {[['', 'Auto'], ['kharif', 'Kharif'], ['rabi', 'Rabi']].map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setSeason(value)}
                  aria-pressed={season === value}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors ${
                    season === value
                      ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="text-[10px] text-slate-500 inline-flex items-center gap-1">
                <CalendarRange className="w-3 h-3" />
                active: {seasonActive} ({weather?.seasonSource || 'auto'})
              </span>
            </div>
          </div>

          <ScenarioPanel
            districtId={district}
            scenarios={scenarios}
            listError={scenariosError}
            activeId={activeScenarioId}
            activeBlock={scenario}
            onSelect={(id) => setScenarioId(id)}
          />
        </section>

        {/* ── F6 primary selector + F8 supplementary map ────────────────────── */}
        <DistrictGrid
          districts={districts}
          active={district}
          loading={!districts && !districtsError}
          error={districtsError}
          onSelect={setDistrict}
        />

        <MapView districts={districts} coords={coords} active={district} onSelect={setDistrict} />

        {/* ── the assessment ───────────────────────────────────────────────── */}
        {weather ? (
          <>
            <SeverityBanner weather={weather} scenario={scenario} />
            <MetricCards weather={weather} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 flex flex-col gap-6">
                <CWSIChart weather={weather} />
                <AuditTrail weather={weather} />
                <ReceiptVerify receipt={weather.receipt} weather={weather} />
                <PlainSummary weather={weather} scenario={scenario} />
              </div>
              <div className="flex flex-col gap-6">
                <PayoutEngine weather={weather} />
                <CooperativePanel
                  coop={coop}
                  loading={coopLoading}
                  error={coopError}
                  scenario={scenario}
                  onOverride={onOverride}
                />
              </div>
            </div>
          </>
        ) : (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm text-amber-400 font-semibold">
              No assessment for this district right now: {weatherError || 'the response did not include one'}.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              The panels below still render their own state — a partial failure is never a blank screen (§19.4).
            </p>
            <button
              type="button"
              onClick={() => setReloadToken((t) => t + 1)}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </section>
        )}

        {/* ── records and history ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <LedgerPanel ledger={ledger} loading={ledgerLoading} scenario={scenario} />
          <RecommendationLog data={recs} loading={!recs && !recsError} error={recsError} />
        </div>

        <BacktestPanel
          backtest={backtest}
          loading={!backtest && !backtestError}
          error={backtestError}
          districtName={weather?.district?.name || district}
        />

        <MethodologyNotes weather={weather} />

        <footer className="text-[10px] text-slate-700 text-center pb-6">
          KrishiSat — decision-support demo · payout figures are recommendations · simulated ledger, no real transactions
        </footer>
      </main>
    </div>
  );
}
