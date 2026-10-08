import React, { useEffect, useRef, useState } from 'react';
import { Calculator, Loader2, Info } from 'lucide-react';
import { api } from '../lib/api';
import { loadVerifiedCore } from '../lib/coreClient';
import { tierLabelOf } from '../constants/severity';
import { fmtINR, fmtPct } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// PayoutEngine — F3's simulator. The simulator EXPLAINS tier logic; it does not
// decide any product's payout. Every call goes to POST /api/calculate-payout
// with §18.3's canonical inputs, and the tier it shows is the one the CORE
// returns (§14.4, §20.2 boundary rule — the frontend never re-derives a tier).
//
// Stage options are enumerated from the served core's own ksStageInfo (one
// table, §12.2) rather than copied into this file: a second, paraphrased stage
// list here would be exactly the duplication §12.2 forbids.
// ─────────────────────────────────────────────────────────────────────────────

async function stageOptions(season) {
  try {
    const { core } = await loadVerifiedCore();
    const seen = new Map();
    for (let month = 1; month <= 12; month++) {
      const info = core.ksStageInfo(month, season === 'rabi' ? 2 : 1);
      if (!seen.has(info.stageId)) seen.set(info.stageId, info.stageLabel);
    }
    return [...seen].map(([stageId, stageLabel]) => ({ stageId, stageLabel }));
  } catch {
    return [];
  }
}

export default function PayoutEngine({ weather }) {
  const e = weather?.parametricDeficitEngine || {};
  const seedKey = `${weather?.district?.id || ''}|${weather?.date || ''}|${weather?.scenario?.id || 'live'}`;

  const [wsi, setWsi] = useState(40);
  const [weeks, setWeeks] = useState(4);
  const [estimated, setEstimated] = useState(false);
  const [stageId, setStageId] = useState('flowering');
  const [season, setSeason] = useState('kharif');
  const [stages, setStages] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  const seededRef = useRef(null);
  const seqRef = useRef(0);

  // Seed from the live computation when the SUBJECT changes (district, day or
  // mode) — never on every background refresh, so a 30-minute auto-refresh can
  // not clobber sliders the user is dragging (§19.5).
  useEffect(() => {
    if (seededRef.current === seedKey || typeof e.weightedShortfallIndex !== 'number') return;
    seededRef.current = seedKey;
    setWsi(Math.round(e.weightedShortfallIndex));
    setWeeks(Math.round(e.droughtDurationWeeks ?? 0));
    setEstimated(e.durationIsEstimated === true);
    setStageId(weather?.cropStage?.stageId || 'flowering');
    setSeason(weather?.season || 'kharif');
  }, [seedKey, e.weightedShortfallIndex, e.droughtDurationWeeks, e.durationIsEstimated, weather]);

  useEffect(() => {
    stageOptions(season).then(setStages);
  }, [season]);

  // One in-flight calculation; a stale response is discarded by sequence number.
  useEffect(() => {
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      setRunning(true);
      setError(null);
      api.payout({
        weightedShortfallIndex: wsi,
        droughtWeeks: weeks,
        durationIsEstimated: estimated,
        cropStage: stageId,
        season,
      })
        .then((res) => {
          if (seqRef.current === seq) { setResult(res); setRunning(false); }
        })
        .catch((err) => {
          if (seqRef.current === seq) { setResult(null); setError(err.message); setRunning(false); }
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [wsi, weeks, estimated, stageId, season]);

  const slider = (value, min, max) => `${((value - min) / (max - min)) * 100}%`;

  return (
    <section className="border rounded-2xl p-5" style={{ background: 'linear-gradient(160deg,rgb(15,23,42) 0%,rgb(2,26,21) 100%)', borderColor: 'rgba(16,185,129,0.25)' }}>
      <h2 className="text-sm font-bold text-emerald-400 flex items-center gap-2 mb-4">
        <Calculator className="w-4 h-4" /> Payout simulator
      </h2>
      <p className="text-[10px] text-slate-500 -mt-2 mb-4">
        Move the inputs to see how the tier responds. The answer is computed by the backend core, not by this page.
      </p>

      <div className="mb-4">
        <div className="flex justify-between text-[11px] font-semibold mb-1.5">
          <label htmlFor="sim-wsi" className="text-slate-300">Weighted shortfall index</label>
          <span className="text-emerald-400">{fmtPct(wsi, 0)}</span>
        </div>
        <input
          id="sim-wsi"
          type="range" min="0" max="100" step="1" value={wsi}
          onChange={(ev) => setWsi(Number(ev.target.value))}
          className="w-full h-2 rounded-full cursor-pointer"
          style={{ accentColor: '#10b981', background: `linear-gradient(to right,#10b981 ${slider(wsi, 0, 100)},#1e293b ${slider(wsi, 0, 100)})` }}
        />
        <div className="flex justify-between text-[9px] text-slate-600 mt-1">
          <span>0</span><span>25 prevented sowing</span><span>35 / 50 / 70 tiers</span><span>100</span>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex justify-between text-[11px] font-semibold mb-1.5">
          <label htmlFor="sim-weeks" className="text-slate-300">Drought duration (real weeks)</label>
          <span className="text-emerald-400">{weeks} wk{weeks === 1 ? '' : 's'}</span>
        </div>
        <input
          id="sim-weeks"
          type="range" min="0" max="8" step="1" value={weeks}
          onChange={(ev) => setWeeks(Number(ev.target.value))}
          className="w-full h-2 rounded-full cursor-pointer"
          style={{ accentColor: '#10b981', background: `linear-gradient(to right,#10b981 ${slider(weeks, 0, 8)},#1e293b ${slider(weeks, 0, 8)})` }}
        />
        <label className="flex items-center gap-2 mt-2 text-[10px] text-slate-400 cursor-pointer">
          <input type="checkbox" checked={estimated} onChange={(ev) => setEstimated(ev.target.checked)} className="accent-emerald-500" />
          Duration is estimated (§12.3) — duration OR-clauses are then disabled and tiers are decided on WSI alone
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <label className="text-[11px] text-slate-300 font-semibold">
          Crop stage
          <select
            value={stageId}
            onChange={(ev) => setStageId(ev.target.value)}
            className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-200 px-2 py-1.5"
          >
            {stages.length === 0 ? <option value={stageId}>{stageId}</option> : null}
            {stages.map((s) => <option key={s.stageId} value={s.stageId}>{s.stageLabel}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-slate-300 font-semibold">
          Season
          <select
            value={season}
            onChange={(ev) => setSeason(ev.target.value)}
            className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-200 px-2 py-1.5"
          >
            <option value="kharif">Kharif</option>
            <option value="rabi">Rabi</option>
          </select>
        </label>
      </div>

      <div className="rounded-xl p-4 text-center bg-slate-950/70 border border-slate-800">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Simulated payout</p>
        {running && !result ? (
          <p className="text-xl font-black text-slate-600 inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> calculating…
          </p>
        ) : error ? (
          <p className="text-xs text-red-400 font-semibold">{error}</p>
        ) : result ? (
          <>
            <p className="text-3xl font-black" style={{ color: result.payoutPerHectare > 0 ? '#2dd4bf' : '#475569' }}>
              {fmtINR(result.payoutPerHectare)}
            </p>
            <p className="text-[11px] text-slate-400 mt-1 font-semibold">
              {result.tierLabel || tierLabelOf(result.tier)} · {result.percentSumInsured}% sum insured
            </p>
            <p className="text-[9px] text-slate-600 mt-2 inline-flex items-center gap-1">
              <Info className="w-3 h-3" />
              Representative Sum Insured (demo); actual PMFBY sums insured are crop- and district-specific via Scale of Finance.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
