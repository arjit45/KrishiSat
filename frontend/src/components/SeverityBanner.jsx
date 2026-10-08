import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { severityOf, tierLabelOf } from '../constants/severity';
import { fmtPct, fmtMultiplier, fmtINR, fmtDate, fmtWks } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// SeverityBanner — severity + trigger assessment for the active district.
//
// Every value is read from the §18.2 payload: severityLevel and isTriggerMet
// are the API's decisions, never re-derived here (§20.2 boundary rule). The
// banner pairs colour with text (§19.1) and, when a source failed, says so
// instead of showing a number it does not have (§16.2).
// ─────────────────────────────────────────────────────────────────────────────

export default function SeverityBanner({ weather, scenario }) {
  const engine = weather?.parametricDeficitEngine || {};
  const sev = severityOf(engine.severityLevel);
  const district = weather?.district || {};
  const stage = weather?.cropStage || {};
  const degraded = engine.weightedShortfallIndex === null || engine.weightedShortfallIndex === undefined;
  const trigger = engine.isTriggerMet === true;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl px-5 py-4 flex flex-wrap items-center gap-4 justify-between">
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-black border ${sev.badge}`}>
          {sev.label}
        </span>
        <div className="text-xs text-slate-400">
          <p className="font-semibold text-slate-200">
            {district.name}
            {district.state ? `, ${district.state}` : ''}
            {weather?.date ? ` · ${fmtDate(weather.date)}` : ''}
            {weather?.season ? ` · ${weather.season} season` : ''}
          </p>
          <p className="text-slate-500">
            {stage.label ? `Crop stage: ${stage.label} (${fmtMultiplier(stage.multiplier)} weight)` : 'Crop stage unavailable'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="text-slate-500">Trigger:</span>
          {degraded ? (
            <span className="font-bold text-slate-500 inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> unknown — source unavailable
            </span>
          ) : trigger ? (
            <span className="font-bold text-rose-400 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> MET — payout eligible
            </span>
          ) : (
            <span className="font-bold text-emerald-400 inline-flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> not met
            </span>
          )}
        </span>

        <span>
          <span className="text-slate-500">Tier: </span>
          <span className="text-slate-200 font-semibold">{tierLabelOf(engine.payoutTier)}</span>
        </span>

        <span>
          <span className="text-slate-500">Payout: </span>
          <span className="text-slate-200 font-semibold">
            {fmtINR(engine.payoutPerHectare) === '—' ? '—' : `${fmtINR(engine.payoutPerHectare)}/ha`}
          </span>
        </span>

        <span>
          <span className="text-slate-500">WSI: </span>
          <span className="text-slate-200 font-semibold">{fmtPct(engine.weightedShortfallIndex)}</span>
        </span>

        <span>
          <span className="text-slate-500">Duration: </span>
          <span className="text-slate-200 font-semibold">
            {fmtWks(engine.droughtDurationWeeks)}
            {engine.durationIsEstimated ? ' (estimated)' : ' (archive)'}
          </span>
        </span>

        {scenario ? (
          <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-300 bg-indigo-950/60 border border-indigo-800/60 px-2 py-0.5 rounded-full">
            replay
          </span>
        ) : null}
      </div>
    </section>
  );
}
