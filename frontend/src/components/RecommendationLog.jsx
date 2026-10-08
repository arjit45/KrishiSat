import React from 'react';
import { History, Inbox, AlertTriangle, Lock } from 'lucide-react';
import { tierLabelOf, severityOf, qualityOf } from '../constants/severity';
import { fmtPct, fmtINR, fmtDate } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// RecommendationLog — F15, the read-only history from GET /api/recommendations
// (§18.9). Newest first; there is no write endpoint anywhere in this API, so
// "append-only" is an absence in the contract rather than a promise in the code
// — which is exactly what the panel states.
//
// A log outage answers 200 with `available: false` and a reason; the panel
// renders that reason instead of an error screen (§16.2, §19.4).
// ─────────────────────────────────────────────────────────────────────────────

export default function RecommendationLog({ data, loading, error }) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const available = data?.available !== false;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Recommendation log">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <History className="w-4 h-4 text-emerald-400" />
            Recommendation log — what was recommended, and when
          </h2>
          <p className="text-[10px] text-slate-500 mt-1">
            Written once per district per day by the scheduled job (§21.2), keyed by the input hash.
            Newest first. <span className="inline-flex items-center gap-1 text-slate-400"><Lock className="w-2.5 h-2.5" /> no edit or delete endpoint exists</span>.
          </p>
        </div>
        <span className="text-[10px] font-mono text-slate-600 shrink-0">{entries.length} rows</span>
      </div>

      {error ? (
        <p className="text-xs text-amber-400 inline-flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </p>
      ) : loading && entries.length === 0 ? (
        <p className="text-xs text-slate-500 italic py-6 text-center">Loading log…</p>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-5 text-center">
          <Inbox className="w-5 h-5 text-slate-600 mx-auto mb-2" />
          <p className="text-xs text-slate-400">
            {available
              ? 'No rows yet — the log is written by the scheduled job, never by a page view.'
              : `History unavailable: ${data?.reason || 'log unreachable'}. The dashboard keeps rendering.`}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                <th className="py-1.5 pr-2 font-semibold">Date</th>
                <th className="py-1.5 pr-2 font-semibold">District</th>
                <th className="py-1.5 pr-2 font-semibold">Season</th>
                <th className="py-1.5 pr-2 font-semibold">WSI</th>
                <th className="py-1.5 pr-2 font-semibold">Tier</th>
                <th className="py-1.5 pr-2 font-semibold text-right">Payout/ha</th>
                <th className="py-1.5 pr-2 font-semibold">Severity</th>
                <th className="py-1.5 pr-2 font-semibold">Quality</th>
                <th className="py-1.5 pr-2 font-semibold">Mode</th>
                <th className="py-1.5 font-semibold">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((row, idx) => {
                const sev = severityOf(row.severityLevel);
                const q = qualityOf(row.aggregateQuality);
                const key = `${row.date}-${row.district}-${idx}`;
                return (
                  <tr key={key} className="border-b border-slate-800/60 last:border-0">
                    <td className="py-1.5 pr-2 text-[10px] text-slate-300 whitespace-nowrap">{fmtDate(row.date)}</td>
                    <td className="py-1.5 pr-2 text-[10px] text-slate-300 font-semibold capitalize">{row.district}</td>
                    <td className="py-1.5 pr-2 text-[10px] text-slate-400">{row.season}</td>
                    <td className="py-1.5 pr-2 text-[10px] text-slate-200">{fmtPct(row.wsi)}</td>
                    <td className="py-1.5 pr-2 text-[10px] text-slate-400 whitespace-nowrap">{tierLabelOf(row.payoutTier)}</td>
                    <td className="py-1.5 pr-2 text-[10px] text-emerald-400 text-right whitespace-nowrap">{fmtINR(row.payoutPerHectare)}</td>
                    <td className={`py-1.5 pr-2 text-[10px] font-semibold ${sev.cls}`}>{sev.label}</td>
                    <td className="py-1.5 pr-2 text-[9px]">
                      <span className={`px-1.5 py-0.5 rounded-full border ${q.cls}`}>{row.aggregateQuality || '—'}</span>
                    </td>
                    <td className="py-1.5 pr-2 text-[9px]">
                      {row.scenarioId
                        ? <span className="text-indigo-300 bg-indigo-950/60 border border-indigo-800/60 px-1.5 py-0.5 rounded-full">replay</span>
                        : <span className="text-slate-500">live</span>}
                    </td>
                    <td className="py-1.5 text-[9px] font-mono text-slate-600">
                      {row.receiptId ? `${String(row.receiptId).slice(0, 10)}…` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data?.nextCursor ? (
            <p className="text-[10px] text-slate-600 mt-2">more rows available (cursor paging) — showing the most recent page</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
