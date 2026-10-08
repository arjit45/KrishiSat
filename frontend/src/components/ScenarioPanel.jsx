import React from 'react';
import { History, Radio, AlertTriangle, Clock } from 'lucide-react';
import { tierLabelOf } from '../constants/severity';
import { fmtDate, fmtPct } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// ScenarioPanel — F14, §19.5, §19.6.
//
// A persistent LIVE / SCENARIO control beside the season toggle. The list is
// served data (GET /api/scenarios), never a hardcoded array — "the scenario list
// is data, not code, so it can change without a release" (§10.2 F14).
//
// While a scenario is active a distinct banner states the period and that this
// is a historic replay over REAL archive data, not current conditions; it also
// states that auto-refresh is suspended (§19.5). Nothing here ever renders a
// scenario without that banner.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{districtId:string, scenarios:Array<object>|null, listError:string|null,
 *   activeId:string|null, activeBlock:object|null, onSelect:(id:string|null)=>void}} props
 */
export default function ScenarioPanel({
  districtId, scenarios, listError, activeId, activeBlock, onSelect,
}) {
  const forDistrict = (scenarios || []).filter((s) => s.districtId === districtId);

  return (
    <div className="flex flex-col gap-3">
      {/* ── the selector itself ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mode</span>

        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors ${
            activeId === null
              ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
          }`}
          aria-pressed={activeId === null}
        >
          <Radio className="w-3.5 h-3.5" />
          LIVE — current conditions
        </button>

        <label className="inline-flex items-center gap-1.5">
          <span className="sr-only">Historic replay scenario</span>
          <History className="w-3.5 h-3.5 text-indigo-400" />
          <select
            value={activeId || ''}
            onChange={(e) => onSelect(e.target.value || null)}
            disabled={forDistrict.length === 0}
            className={`bg-slate-900 border rounded-lg text-[11px] font-semibold px-2.5 py-1.5 ${
              activeId ? 'border-indigo-600 text-indigo-300' : 'border-slate-700 text-slate-300'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            title={listError || 'Historic replay (F14) — real archive data'}
          >
            <option value="">SCENARIO — pick a historic replay…</option>
            {forDistrict.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}{s.trigger ? '' : ' (non-trigger)'}
              </option>
            ))}
          </select>
        </label>

        {listError ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-400">
            <AlertTriangle className="w-3 h-3" />
            scenario list unavailable: {listError}
          </span>
        ) : null}
        {!listError && forDistrict.length === 0 ? (
          <span className="text-[10px] text-slate-500">no scenarios published for this district</span>
        ) : null}
      </div>

      {/* ── the banner (§19.6): never optional while a scenario is active ─── */}
      {activeId ? (
        <div className="rounded-2xl border border-indigo-800/60 bg-indigo-950/40 px-4 py-3">
          <p className="text-[11px] font-black text-indigo-300 uppercase tracking-wider flex items-center gap-2">
            <History className="w-3.5 h-3.5" />
            Historic replay — real archive data, not current conditions
          </p>
          <p className="text-sm text-indigo-100 font-semibold mt-1">
            {activeBlock?.label || activeId}
            {' · '}
            {activeBlock ? `${fmtDate(activeBlock.period?.from)} – ${fmtDate(activeBlock.period?.to)}` : ''}
          </p>
          <p className="text-[11px] text-indigo-300/80 mt-1">
            Replaying the day of {fmtDate(activeBlock?.anchorDate)} from the Open-Meteo Archive window{' '}
            {fmtDate(activeBlock?.dataWindow?.from)} – {fmtDate(activeBlock?.dataWindow?.to)}
            {' · '}
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" /> auto-refresh suspended
            </span>
          </p>

          {activeBlock?.selection ? (
            <p className="text-[10px] text-indigo-400/70 mt-2">
              Selected as {activeBlock.selection.basis} — {fmtPct(activeBlock.selection.peakWsi)} peak WSI,{' '}
              {tierLabelOf(activeBlock.selection.payoutTier)} at selection time ({activeBlock.selection.source}).
              The tier shown on the dashboard is what THIS replay computes from archive data.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
