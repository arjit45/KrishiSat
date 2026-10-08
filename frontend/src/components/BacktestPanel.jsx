import React from 'react';
import { LineChart, AlertTriangle, Info } from 'lucide-react';
import { tierLabelOf } from '../constants/severity';
import { fmtPct, fmtINR, fmtDate } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// BacktestPanel — F11 (and F9's actuarial summary, which is derived entirely
// from this same snapshot: no new external calls, §10.2 F9).
//
// The labelling travels with the numbers: this is the NASA POWER hindcast, a
// DIFFERENT reanalysis than the live view, and a methodology sanity check —
// never a validation against real claim outcomes (§28.8). The §24 band is shown
// as reported, and the saturation caveat is shown beside the frequency rather
// than after it, because a near-100% season-peak frequency is an open question
// in §12.6, not a result.
// ─────────────────────────────────────────────────────────────────────────────

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2">
      <p className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-sm font-black text-slate-100">{value}</p>
      {hint ? <p className="text-[9px] text-slate-600">{hint}</p> : null}
    </div>
  );
}

/**
 * @param {{backtest:object|null, loading:boolean, error:string|null, districtName:string}} props
 */
export default function BacktestPanel({ backtest, loading, error, districtName }) {
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Historical backtest">
      <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-1">
        <LineChart className="w-4 h-4 text-emerald-400" />
        Historical backtest — {districtName || 'district'}
      </h2>
      <p className="text-[10px] text-slate-500 mb-3">
        {loading ? 'Loading committed snapshot…' : 'Replay of the shipped core over 20 season-years of daily rainfall.'}
      </p>

      {error ? (
        <p className="text-xs text-amber-400 inline-flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
        </p>
      ) : null}

      {!error && backtest ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat
              label="Trigger frequency"
              value={backtest.triggerFrequency === null || backtest.triggerFrequency === undefined ? '—' : fmtPct(backtest.triggerFrequency)}
              hint={backtest.triggerBand ? `§24 band ${backtest.triggerBand[0]}–${backtest.triggerBand[1]}` : 'no band yet'}
            />
            <Stat label="Seasons evaluated" value={backtest.seasonsEvaluated ?? '—'} hint={`${backtest.years ?? '—'} years × 2 seasons`} />
            <Stat
              label="Peak WSI (median)"
              value={fmtPct(backtest.peakWsiStats?.median)}
              hint={`range ${fmtPct(backtest.peakWsiStats?.min)} – ${fmtPct(backtest.peakWsiStats?.max)}`}
            />
            <Stat
              label="Cumulative payout"
              value={`${fmtINR(backtest.cumulativePayoutPerHectare)}/ha`}
              hint="over the evaluated seasons"
            />
          </div>

          {/* F9 — actuarial read, all from this snapshot, all labelled working */}
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat
              label="≥ Tier 3 seasons"
              value={backtest.triggerFrequencyAtLeastTier?.TIER_3_CATASTROPHIC != null ? fmtPct(backtest.triggerFrequencyAtLeastTier.TIER_3_CATASTROPHIC) : '—'}
              hint="seasons reaching the top tier"
            />
            <Stat
              label="Return period (any trigger)"
              value={backtest.triggerFrequency ? `~${(100 / backtest.triggerFrequency).toFixed(1)} yr` : '—'}
              hint="season-peak definition (§11.6)"
            />
            <Stat
              label="Risk rating [WORKING]"
              value={
                (backtest.triggerFrequency ?? 0) >= 75 ? 'EXTREME'
                  : (backtest.triggerFrequency ?? 0) >= 50 ? 'HIGH'
                    : (backtest.triggerFrequency ?? 0) >= 25 ? 'MEDIUM' : 'LOW'
              }
              hint="indicative only, not actuarial"
            />
            <Stat
              label="Premium indicator [WORKING]"
              value={backtest.cumulativePayoutPerHectare && backtest.years
                ? `${fmtINR(Math.round(backtest.cumulativePayoutPerHectare / backtest.years))}/ha/yr`
                : '—'}
              hint="illustrative only — not a quoted premium"
            />
          </div>

          <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2.5">
            <p className="text-[10px] text-slate-400 flex items-start gap-1.5">
              <Info className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500" />
              <span>
                Source: <span className="text-slate-300">{backtest.source}</span> · period{' '}
                <span className="text-slate-300">{backtest.period}</span> · generated {fmtDate(String(backtest.generatedAt || '').slice(0, 10))}.
                This replays the same methodology over a different reanalysis than the live view —
                a methodology sanity check, <span className="text-amber-400">NOT a validation against real claim outcomes</span>.
                The soil leg is absent from this source, so every season is marked estimated duration.
              </span>
            </p>
            {backtest.methodology?.openFinding ? (
              <p className="text-[10px] text-amber-500/90 mt-1.5 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{backtest.methodology.openFinding}</span>
              </p>
            ) : null}
          </div>

          <details className="mt-3">
            <summary className="text-[10px] text-slate-400 cursor-pointer">
              Season records ({(backtest.records || []).length}) — most severe first
            </summary>
            <div className="max-h-44 overflow-y-auto mt-1.5">
              <table className="w-full text-left">
                <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="py-1 pr-2">Season</th>
                    <th className="py-1 pr-2">Peak date</th>
                    <th className="py-1 pr-2">Peak WSI</th>
                    <th className="py-1 pr-2">Tier</th>
                    <th className="py-1 pr-2 text-right">Payout/ha</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(backtest.records || [])]
                    .sort((a, b) => (b.peakWsi ?? 0) - (a.peakWsi ?? 0))
                    .slice(0, 40)
                    .map((r) => (
                      <tr key={`${r.season}-${r.year}`} className="border-b border-slate-800/50 last:border-0">
                        <td className="py-1 pr-2 text-[10px] text-slate-300">{r.season} {r.year}</td>
                        <td className="py-1 pr-2 text-[10px] text-slate-500">{r.peakDate}</td>
                        <td className="py-1 pr-2 text-[10px] text-slate-300">{fmtPct(r.peakWsi)}</td>
                        <td className="py-1 pr-2 text-[10px] text-slate-400">{tierLabelOf(r.tier)}</td>
                        <td className="py-1 pr-2 text-[10px] text-emerald-400 text-right">{fmtINR(r.payoutPerHectare)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : null}

      {!error && !backtest && !loading ? (
        <p className="text-xs text-slate-500">No snapshot available.</p>
      ) : null}
    </section>
  );
}
