import React from 'react';
import { Grid2X2 } from 'lucide-react';
import { severityOf, tierLabelOf, qualityOf } from '../constants/severity';
import { fmtPct } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// DistrictGrid — F6, the PRIMARY district selector.
//
// Shows all four districts at once from GET /api/districts (§18.1): name +
// state, zone, current WSI, severity badge, payout tier and crop stage. The
// severity and tier are the API's own strings — this component never derives
// either (§20.2 boundary rule). A district whose source failed shows "—" and its
// quality mark rather than a fabricated number (§16.2).
//
// Selection lives at app level (§9.3), so F6 and the map (F8) cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

function QualityDot({ quality }) {
  const q = qualityOf(quality);
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-slate-500" title={`Data quality: ${quality || 'unknown'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${q.dot}`} />
      {quality || '—'}
    </span>
  );
}

/**
 * @param {{districts:Array<object>|null, active:string, loading:boolean,
 *   error:string|null, onSelect:(id:string)=>void}} props
 */
export default function DistrictGrid({ districts, active, loading, error, onSelect }) {
  if (error) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <p className="text-xs font-semibold text-amber-400">
          District summary unavailable: {error}
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          The dashboard below still renders from its own fetch (§19.4 — partial failure is never a blank screen).
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="district-grid-heading">
      <p id="district-grid-heading" className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
        <Grid2X2 className="w-3.5 h-3.5" /> District risk grid
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(districts || []).map((d) => {
          const isActive = active === d.id;
          const sev = severityOf(d.severity);
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelect(d.id)}
              aria-pressed={isActive}
              className="text-left p-4 rounded-2xl border transition-all duration-150 bg-slate-900 hover:border-slate-600"
              style={{
                borderColor: isActive ? 'rgba(16,185,129,0.55)' : undefined,
                boxShadow: isActive ? '0 0 18px rgba(16,185,129,0.12)' : undefined,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest truncate">{d.zone}</p>
                <QualityDot quality={d.dataQuality} />
              </div>
              <p className="text-base font-black text-slate-100 mt-1">{d.name}</p>
              <p className="text-[11px] text-slate-400">{d.state}</p>

              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-lg font-black text-slate-100">{fmtPct(d.wsi)}</span>
                <span className="text-[9px] text-slate-500 uppercase tracking-wider">WSI</span>
              </div>

              <span className={`inline-flex items-center mt-2 px-2 py-0.5 rounded-full text-[9px] font-bold border ${sev.badge}`}>
                {sev.label}
              </span>

              <p className="text-[10px] text-slate-400 mt-2 font-semibold">{tierLabelOf(d.payoutTier)}</p>
              <p className="text-[10px] text-slate-500 truncate">{d.cropStage}</p>
            </button>
          );
        })}

        {loading && !districts ? (
          <p className="text-xs text-slate-500 col-span-2 md:col-span-4 py-6 text-center">Loading district summaries…</p>
        ) : null}
        {!loading && (!districts || districts.length === 0) && !error ? (
          <p className="text-xs text-slate-500 col-span-2 md:col-span-4 py-6 text-center">No district summaries returned.</p>
        ) : null}
      </div>
    </section>
  );
}
