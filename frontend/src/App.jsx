import React, { useState, useEffect, useCallback } from 'react';
import {
  CloudRain, Droplet, Satellite, ShieldAlert, CheckCircle,
  TrendingUp, Activity, Zap, Leaf, WifiOff,
} from 'lucide-react';
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const API = 'http://localhost:5000';

// District IDs must be lowercase — they are used verbatim in /api/weather/:id
const DISTRICTS = [
  { id: 'jalna', name: 'Jalna', state: 'Maharashtra', zone: 'Marathwada' },
  { id: 'bikaner', name: 'Bikaner', state: 'Rajasthan', zone: 'Arid Desert' },
  { id: 'dewas', name: 'Dewas', state: 'Madhya Pradesh', zone: 'Malwa Plateau' },
  { id: 'anantapur', name: 'Anantapur', state: 'Andhra Pradesh', zone: 'Rayalaseema' },
];

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
const safeNum = (v, fallback = 0) => (typeof v === 'number' && isFinite(v) ? v : fallback);
const fmtINR = (n) => safeNum(n).toLocaleString('en-IN');
const fmtPct = (n) => `${safeNum(n).toFixed(1)}%`;
const fmtWks = (n) => `${safeNum(n).toFixed(1)} wks`;

function getSeverity(shortfall) {
  const s = safeNum(shortfall);
  if (s >= 60) return 'CATASTROPHIC_DROUGHT';
  if (s >= 45) return 'SEVERE_DROUGHT';
  if (s >= 30) return 'MODERATE_DEFICIT';
  return 'NORMAL';
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function MetricCard({ icon: Icon, iconColor, label, value, sub, subColor }) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</p>
        <Icon className={`w-4 h-4 ${iconColor || 'text-slate-400'}`} />
      </div>
      <p className="text-3xl font-black text-slate-100 mt-1">{value}</p>
      <p className={`text-xs font-medium ${subColor || 'text-slate-400'}`}>{sub}</p>
    </div>
  );
}

function SeverityBadge({ severity }) {
  const MAP = {
    CATASTROPHIC_DROUGHT: { label: '🔴 CATASTROPHIC', cls: 'bg-red-950/60 text-red-400 border-red-800/50' },
    SEVERE_DROUGHT: { label: '🟠 SEVERE DROUGHT', cls: 'bg-orange-950/60 text-orange-400 border-orange-800/50' },
    MODERATE_DEFICIT: { label: '🟡 MODERATE DEFICIT', cls: 'bg-amber-950/60 text-amber-400 border-amber-800/50' },
    NORMAL: { label: '🟢 NORMAL CONDITIONS', cls: 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50' },
  };
  const b = MAP[severity] ?? MAP['NORMAL'];
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-bold border ${b.cls}`}>
      {b.label}
    </span>
  );
}

function CropsStrip({ crops }) {
  if (!Array.isArray(crops) || crops.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <span className="flex items-center gap-1 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
        <Leaf className="w-3 h-3 text-emerald-600" /> Crops:
      </span>
      {crops.map((c) => (
        <span key={c} className="px-2.5 py-1 rounded-full text-[11px] font-semibold text-emerald-300 bg-emerald-950/50 border border-emerald-800/40">
          {c}
        </span>
      ))}
    </div>
  );
}

function LoadingScreen({ district }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 bg-slate-950"
      style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="relative flex items-center justify-center">
        <div className="absolute w-32 h-32 rounded-full border-2 border-emerald-500/20 animate-spin" style={{ animationDuration: '4s' }} />
        <div className="absolute w-24 h-24 rounded-full border-2 border-teal-400/30 animate-spin" style={{ animationDuration: '2.5s', animationDirection: 'reverse' }} />
        <div className="bg-emerald-500/10 border border-emerald-500/30 p-5 rounded-2xl">
          <Satellite className="w-12 h-12 text-emerald-400" />
        </div>
      </div>
      <div className="text-center">
        <h1 className="text-2xl font-black text-slate-100 mb-2">Connecting to Orbital Telemetry Stream...</h1>
        <p className="text-sm text-slate-400">
          Acquiring satellite feed for{' '}
          <span className="text-emerald-400 font-semibold capitalize">{district}</span>
        </p>
      </div>
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"
            style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-slate-950 px-6"
      style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="bg-red-950/40 border border-red-800/50 rounded-2xl p-8 max-w-lg w-full text-center">
        <WifiOff className="w-12 h-12 text-red-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-red-300 mb-2">Telemetry Link Failed</h2>
        <p className="text-sm text-slate-400 mb-2">{message}</p>
        <p className="text-xs text-slate-600 mb-6">
          Make sure the backend is running:{' '}
          <code className="text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded">node server.js</code>
          {' '}in the <code className="text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded">backend/</code> folder
        </p>
        <button onClick={onRetry}
          className="px-6 py-3 rounded-xl text-sm font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 transition-colors">
          Retry Connection
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [district, setDistrict] = useState('jalna');
  const [weather, setWeather] = useState(null);   // raw /api/weather/:district JSON
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  // Payout slider state — seeded from live data on fetch
  const [shortfallSlider, setShortfallSlider] = useState(40);
  const [durationSlider, setDurationSlider] = useState(4);
  const [payout, setPayout] = useState(null); // null = not yet calculated

  // Ledger — always kept as an array
  const [ledger, setLedger] = useState([]);

  // ── 1. Fetch weather on district change ────────────────────────────────────
  const fetchWeather = useCallback(() => {
    setLoading(true);
    setFetchError(null);
    setWeather(null);

    fetch(`${API}/api/weather/${district}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
        return res.json();
      })
      .then((data) => {
        // Validate the shape we depend on exists
        if (!data?.parametricDeficitEngine || !data?.district) {
          throw new Error('Backend returned unexpected JSON shape. Restart server.js.');
        }
        setWeather(data);

        // Seed sliders from live values so payout auto-calculates on load
        const pde = data.parametricDeficitEngine;
        if (typeof pde.rainfallShortfallPercentage === 'number') setShortfallSlider(Math.round(pde.rainfallShortfallPercentage));
        if (typeof pde.droughtDurationWeeks === 'number') setDurationSlider(Math.round(pde.droughtDurationWeeks));

        setLoading(false);
      })
      .catch((err) => {
        console.error('[KrishiSat] Weather fetch failed:', err.message);
        setFetchError(`Cannot reach ${API}. ${err.message}`);
        setLoading(false);
      });
  }, [district]);

  useEffect(() => { fetchWeather(); }, [fetchWeather]);

  // ── 2. Fetch ledger once on mount ──────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/api/ledger`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => {
        // Accept either a root array or { transactions: [] }
        if (Array.isArray(data)) setLedger(data);
        else if (Array.isArray(data?.transactions)) setLedger(data.transactions);
        else setLedger([]);
      })
      .catch((err) => {
        console.warn('[KrishiSat] Ledger fetch failed:', err.message);
        setLedger([]); // safe empty — component handles length === 0 gracefully
      });
  }, []);

  // ── 3. Calculate payout whenever sliders change ────────────────────────────
  //   POST body:  { shortfall: Number, weeks: Number }
  //   Response:   { payoutPerHectare: Number, tier: String }
  useEffect(() => {
    setPayout(null); // show calculating state
    fetch(`${API}/api/calculate-payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortfall: shortfallSlider, weeks: durationSlider }),
    })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => {
        // Response key: payoutPerHectare (number) — NOT payoutPerHectareINR
        const amount = typeof data?.payoutPerHectare === 'number' ? data.payoutPerHectare : 0;
        setPayout({ amount, tier: data?.tier ?? 'BELOW_THRESHOLD' });
      })
      .catch((err) => {
        console.warn('[KrishiSat] Payout calc failed:', err.message);
        setPayout({ amount: 0, tier: 'BELOW_THRESHOLD' });
      });
  }, [shortfallSlider, durationSlider]);

  // ── GUARD: Loading screen ──────────────────────────────────────────────────
  if (loading) return <LoadingScreen district={district} />;

  // ── GUARD: Error screen ────────────────────────────────────────────────────
  if (fetchError || !weather?.parametricDeficitEngine || !weather?.district) {
    return (
      <ErrorScreen
        message={fetchError ?? 'Backend returned invalid data shape.'}
        onRetry={() => fetchWeather()}
      />
    );
  }

  // ── All data confirmed present — safe to destructure ──────────────────────
  //
  //  Backend response shape (from /api/weather/:district):
  //    weather.district.name
  //    weather.district.state
  //    weather.district.agroZone
  //    weather.district.primaryCrops        ← string[]
  //    weather.parametricDeficitEngine.rainfallShortfallPercentage
  //    weather.parametricDeficitEngine.soilMoistureDeficitPercentage
  //    weather.parametricDeficitEngine.droughtDurationWeeks
  //    weather.parametricDeficitEngine.isTriggerMet
  //    weather.parametricDeficitEngine.severityLevel
  //
  //  Backend response shape (from /api/calculate-payout):
  //    payout.amount      ← number (payoutPerHectare from server)
  //    payout.tier        ← string
  //
  //  Backend response shape (from /api/ledger):
  //    ledger[i].farmerName   ← dynamic Indian name from server
  //    ledger[i].cooperative
  //    ledger[i].tier
  //    ledger[i].amount       ← number
  //    ledger[i].timestamp

  const pde = weather.parametricDeficitEngine;
  const distObj = weather.district;

  const shortfall = safeNum(pde.rainfallShortfallPercentage);
  const soilDeficit = safeNum(pde.soilMoistureDeficitPercentage);
  const drought = safeNum(pde.droughtDurationWeeks);
  const isTrigger = pde.isTriggerMet === true;
  const severity = typeof pde.severityLevel === 'string' ? pde.severityLevel : getSeverity(shortfall);

  const distName = distObj.name ?? district;
  const stateName = distObj.state ?? '';
  const agroZone = distObj.agroZone ?? '';
  const crops = Array.isArray(distObj.primaryCrops) ? distObj.primaryCrops : [];

  // Chart data — NDVI proxy derived from shortfall
  const ndviNow = parseFloat(Math.max(0.05, Math.min(0.95, 1 - shortfall / 100)).toFixed(2));
  const chartData = {
    labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Now'],
    datasets: [{
      fill: true,
      label: 'NDVI Index',
      data: [0.65, 0.58, 0.48, 0.42, ndviNow],
      borderColor: 'rgb(16,185,129)',
      backgroundColor: 'rgba(16,185,129,0.08)',
      tension: 0.4,
      pointRadius: 4,
      pointBackgroundColor: 'rgb(16,185,129)',
    }],
  };
  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#1e293b' }, min: 0, max: 1 },
    },
  };

  const txList = Array.isArray(ledger) ? ledger : [];
  const payoutAmount = payout?.amount ?? 0;
  const payoutReady = payout !== null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100"
      style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>

      {/* ── HEADER ──────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500 p-2 rounded-xl" style={{ boxShadow: '0 0 20px rgba(16,185,129,0.3)' }}>
              <Satellite className="w-7 h-7 text-slate-950" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight"
                style={{ background: 'linear-gradient(90deg,#34d399,#2dd4bf)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                KrishiSat
              </h1>
              <p className="text-xs text-slate-400 font-medium">Parametric Agricultural Insurance · Orbital Telemetry</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span className="text-emerald-400">ORACLE LIVE</span>
            </div>
            <div className="hidden md:flex items-center gap-2 text-xs text-slate-500 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>Instant Settlement Protocol Active</span>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ── DISTRICT SELECTOR ─────────────────────────────────────────────── */}
        <section className="mb-8">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">
            Select Satellite Targeting Region
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {DISTRICTS.map((d) => {
              const active = district === d.id;
              return (
                <button key={d.id} onClick={() => setDistrict(d.id)}
                  className="text-left p-5 rounded-2xl border transition-all duration-200"
                  style={{
                    background: active ? 'rgba(6,78,59,0.3)' : 'rgba(15,23,42,1)',
                    borderColor: active ? 'rgba(16,185,129,0.5)' : 'rgba(30,41,59,1)',
                    boxShadow: active ? '0 0 20px rgba(16,185,129,0.1)' : 'none',
                  }}>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{d.zone}</p>
                  <p className="text-lg font-black text-slate-100 mt-1">{d.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{d.state}</p>
                  {active && (
                    <span className="inline-block mt-3 text-[10px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded-full">
                      ● TARGETED
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* ── SEVERITY BAR ──────────────────────────────────────────────────── */}
        <div className="mb-8 bg-slate-900 border border-slate-800 rounded-2xl px-5 py-4 flex flex-wrap items-center gap-4 justify-between">
          <div>
            <p className="text-xs text-slate-500 font-medium mb-1">Drought Severity Assessment</p>
            <SeverityBadge severity={severity} />
          </div>
          <div className="flex gap-6 text-xs text-slate-400 flex-wrap">
            <span><span className="text-slate-500">District: </span><span className="text-slate-200 font-semibold">{distName}</span></span>
            <span><span className="text-slate-500">State: </span><span className="text-slate-200 font-semibold">{stateName}</span></span>
            {agroZone && <span><span className="text-slate-500">Zone: </span><span className="text-slate-200 font-semibold">{agroZone}</span></span>}
            <span>
              <span className="text-slate-500">Trigger Met: </span>
              <span className={`font-bold ${isTrigger ? 'text-rose-400' : 'text-emerald-400'}`}>
                {isTrigger ? 'YES — Payout Eligible' : 'NO'}
              </span>
            </span>
          </div>
        </div>

        {/* ── MAIN GRID ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* LEFT — 2-col span */}
          <div className="lg:col-span-2 flex flex-col gap-6">

            {/* Telemetry metric cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <MetricCard icon={CloudRain} iconColor="text-sky-400"
                label="Rainfall Shortfall" value={fmtPct(shortfall)}
                sub="vs. 10-yr monsoon baseline"
                subColor={shortfall > 30 ? 'text-rose-400' : 'text-slate-400'} />
              <MetricCard icon={Droplet} iconColor="text-teal-400"
                label="Soil Moisture Deficit" value={fmtPct(soilDeficit)}
                sub="root-zone depletion"
                subColor={soilDeficit > 30 ? 'text-amber-400' : 'text-slate-400'} />
              <MetricCard icon={Activity} iconColor="text-amber-400"
                label="Drought Duration" value={fmtWks(drought)}
                sub="consecutive stress weeks"
                subColor={drought > 3 ? 'text-rose-400' : 'text-slate-400'} />
            </div>

            {/* Primary crops strip */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl px-5 py-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                Target Region Agricultural Profile
              </p>
              <CropsStrip crops={crops} />
            </div>

            {/* NDVI Chart */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-sm font-bold text-slate-200">NDVI Vegetation Health Index</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Canopy health proxy · 4-week satellite trend</p>
                </div>
                <span className="text-xs font-bold px-2 py-1 rounded-lg bg-slate-800 text-emerald-400">Now: {ndviNow}</span>
              </div>
              <div style={{ height: '200px' }}>
                <Line data={chartData} options={chartOptions} />
              </div>
            </section>
          </div>

          {/* RIGHT — 1-col span */}
          <div className="flex flex-col gap-6">

            {/* ── Parametric Payout Engine ───────────────────────────────────── */}
            <section className="border rounded-2xl p-6"
              style={{ background: 'linear-gradient(160deg,rgb(15,23,42) 0%,rgb(2,26,21) 100%)', borderColor: 'rgba(16,185,129,0.25)', boxShadow: '0 0 40px rgba(16,185,129,0.06)' }}>
              <h2 className="text-base font-bold text-emerald-400 flex items-center gap-2 mb-6">
                <TrendingUp className="w-4 h-4" /> Parametric Payout Engine
              </h2>

              {/* Slider: Rainfall Shortfall */}
              <div className="mb-5">
                <div className="flex justify-between text-xs font-semibold mb-2">
                  <span className="text-slate-300">Rainfall Shortfall</span>
                  <span className="text-emerald-400">{shortfallSlider}%</span>
                </div>
                <input type="range" min="0" max="100" value={shortfallSlider}
                  onChange={(e) => setShortfallSlider(Number(e.target.value))}
                  className="w-full h-2 rounded-full cursor-pointer"
                  style={{ accentColor: '#10b981', background: `linear-gradient(to right,#10b981 ${shortfallSlider}%,#1e293b ${shortfallSlider}%)` }} />
                <div className="flex justify-between text-[10px] text-slate-600 mt-1">
                  <span>0%</span><span>30% trigger</span><span>100%</span>
                </div>
              </div>

              {/* Slider: Dry Spell Duration */}
              <div className="mb-6">
                <div className="flex justify-between text-xs font-semibold mb-2">
                  <span className="text-slate-300">Dry Spell Duration</span>
                  <span className="text-emerald-400">{durationSlider} wks</span>
                </div>
                <input type="range" min="0" max="8" value={durationSlider}
                  onChange={(e) => setDurationSlider(Number(e.target.value))}
                  className="w-full h-2 rounded-full cursor-pointer"
                  style={{ accentColor: '#10b981', background: `linear-gradient(to right,#10b981 ${(durationSlider / 8) * 100}%,#1e293b ${(durationSlider / 8) * 100}%)` }} />
                <div className="flex justify-between text-[10px] text-slate-600 mt-1">
                  <span>0 wks</span><span>2 wks trigger</span><span>8 wks</span>
                </div>
              </div>

              {/* Payout result */}
              <div className="rounded-xl p-5 text-center"
                style={{ background: 'rgba(2,6,23,0.8)', border: '1px solid rgba(30,41,59,1)' }}>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Instant Settlement Estimate
                </p>
                {!payoutReady ? (
                  <p className="text-2xl font-black text-slate-600 animate-pulse">Calculating…</p>
                ) : (
                  <>
                    <p className="text-4xl font-black" style={{ color: payoutAmount > 0 ? '#2dd4bf' : '#475569' }}>
                      ₹{fmtINR(payoutAmount)}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-2">per hectare · max ₹50,000</p>
                    <div className="mt-3 pt-3 border-t border-slate-800 text-[10px] font-semibold">
                      {payoutAmount > 0
                        ? <span className="text-emerald-400">✓ Payout trigger threshold MET</span>
                        : <span className="text-slate-500">Shortfall &lt;30% — below trigger threshold</span>
                      }
                    </div>
                  </>
                )}
              </div>
            </section>

            {/* ── Smart Contract Ledger ──────────────────────────────────────── */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col">
              <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-4">
                <CheckCircle className="w-4 h-4 text-emerald-400" /> Recent Auto-Settlements
              </h2>
              <div className="space-y-2 overflow-y-auto" style={{ maxHeight: '320px' }}>
                {txList.length === 0 ? (
                  <p className="text-xs text-slate-600 italic py-6 text-center">
                    Waiting for ledger data from backend…
                  </p>
                ) : (
                  txList.map((tx, idx) => {
                    // tx fields come directly from /api/ledger — all guarded
                    const farmerName = tx?.farmerName || '—';
                    const cooperative = tx?.cooperative || '—';
                    const tier = tx?.tier || '—';
                    const amount = safeNum(tx?.amount, 0);
                    const timestamp = tx?.timestamp || '';
                    return (
                      <div key={idx} className="rounded-xl p-3 flex justify-between items-center gap-2"
                        style={{ background: 'rgba(2,6,23,0.6)', border: '1px solid rgba(30,41,59,0.8)' }}>
                        <div className="min-w-0">
                          {/* farmerName is a DYNAMIC value from Express server — never hardcoded */}
                          <p className="text-xs font-bold text-slate-200 truncate">{farmerName}</p>
                          <p className="text-[10px] text-slate-500 truncate">{cooperative}</p>
                          <p className="text-[10px] text-slate-600 truncate">{tier}</p>
                          {timestamp && <p className="text-[9px] text-slate-700 mt-0.5">{timestamp}</p>}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-black text-emerald-400">₹{fmtINR(amount)}</p>
                          <span className="inline-block text-[9px] font-bold text-emerald-400 px-1.5 py-0.5 rounded-full mt-0.5"
                            style={{ background: 'rgba(6,78,59,0.5)', border: '1px solid rgba(16,185,129,0.3)' }}>
                            SETTLED
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}