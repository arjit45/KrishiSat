import React from 'react';
import { Users, Pencil, Info, AlertTriangle, Loader2 } from 'lucide-react';
import { tierLabelOf, qualityOf } from '../constants/severity';
import { fmtINR, fmtHa, fmtPct, safeNum } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// CooperativePanel — F12, the cooperative payout aggregation.
//
// memberPayout = hectares × tierPayoutPerHectare (0 when the district is not
// triggering), cooperativeSum = Σ memberPayout — both computed server-side from
// the committed roster; this component only edits hectares and re-sends them
// (§18.7). It states the two disclosures wherever hectares are editable: the
// roster is an "illustrative sample of N members", and changes are session-only
// because the server holds no member state (§16.3).
//
// A null cooperativeSum renders as "unknown", never as ₹0 (§16.2): "we do not
// know" and "there is no payout" are different claims.
// ─────────────────────────────────────────────────────────────────────────────

export default function CooperativePanel({ coop, loading, error, scenario, onOverride }) {
  if (error) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" /> Cooperative aggregation
        </h2>
        <p className="text-xs text-amber-400 mt-3 inline-flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> unavailable: {error}
        </p>
      </section>
    );
  }

  if (!coop) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" /> Cooperative aggregation
        </h2>
        <p className="text-xs text-slate-500 mt-3 inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {loading ? 'Loading roster…' : 'No data.'}
        </p>
      </section>
    );
  }

  const { members = [], aggregate = {}, assessment = {}, roster = {}, persistence = {} } = coop;
  const quality = qualityOf(assessment.dataQuality);
  const triggering = assessment.isTriggerMet === true;
  const sum = safeNum(aggregate.cooperativeSum);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Cooperative payout aggregation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-400" /> {coop.cooperative || 'Cooperative aggregation'}
          </h2>
          <p className="text-[11px] text-slate-500 mt-1">
            {roster.label || 'illustrative roster'} · {roster.memberCount ?? members.length} members ·{' '}
            <span className="text-slate-400">{assessment.tierLabel || tierLabelOf(assessment.payoutTier)}</span>
          </p>
        </div>
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${quality.cls}`}>{quality.label}</span>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] mt-3">
        <span className="text-slate-400">
          Trigger: <span className={triggering ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold'}>{triggering ? 'MET' : 'not met'}</span>
        </span>
        <span className="text-slate-400">Payout rate: <span className="text-slate-200 font-semibold">{fmtINR(assessment.payoutPerHectare)}/ha</span></span>
        <span className="text-slate-400">WSI: <span className="text-slate-200 font-semibold">{fmtPct(assessment.wsi)}</span></span>
        <span className="text-slate-400">Duration: <span className="text-slate-200 font-semibold">{assessment.durationIsEstimated ? 'estimated' : 'real'}</span></span>
        {scenario ? <span className="text-indigo-300 font-bold">replay: {scenario.label}</span> : null}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2">
          <p className="text-[9px] text-slate-500 uppercase tracking-wider">Total area</p>
          <p className="text-sm font-black text-slate-100">{fmtHa(aggregate.totalHectares)}</p>
        </div>
        <div className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2">
          <p className="text-[9px] text-slate-500 uppercase tracking-wider">Triggering members</p>
          <p className="text-sm font-black text-slate-100">{aggregate.triggeringMembers ?? 0} / {aggregate.memberCount ?? members.length}</p>
        </div>
        <div className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2">
          <p className="text-[9px] text-slate-500 uppercase tracking-wider">Cooperative sum</p>
          <p className="text-sm font-black" style={{ color: sum === null ? '#f59e0b' : '#34d399' }}>
            {sum === null ? 'unknown' : fmtINR(sum)}
          </p>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <th className="py-1.5 pr-2 font-semibold">Member</th>
              <th className="py-1.5 pr-2 font-semibold">Reference</th>
              <th className="py-1.5 pr-2 font-semibold">Hectares</th>
              <th className="py-1.5 pr-2 font-semibold text-right">Payout</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.memberRef} className="border-b border-slate-800/60 last:border-0">
                <td className="py-1.5 pr-2 text-[11px] text-slate-200 font-semibold whitespace-nowrap">{m.name}</td>
                <td className="py-1.5 pr-2 text-[10px] text-slate-500 font-mono whitespace-nowrap">{m.memberRef}</td>
                <td className="py-1.5 pr-2">
                  <span className="inline-flex items-center gap-1.5">
                    <input
                      type="number"
                      min="0.1"
                      max="100"
                      step="0.1"
                      value={m.effectiveHectares}
                      onChange={(ev) => {
                        const raw = ev.target.value;
                        onOverride(m.memberRef, raw === '' ? null : Number(raw));
                      }}
                      aria-label={`Hectares for ${m.name}`}
                      className="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-100 focus:border-emerald-600 focus:outline-none"
                    />
                    {m.overridden ? (
                      <span className="text-[8px] font-bold text-amber-400 inline-flex items-center gap-0.5" title="edited in this session">
                        <Pencil className="w-2.5 h-2.5" />
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-[11px] text-emerald-400 font-bold text-right whitespace-nowrap">
                  {fmtINR(m.memberPayout)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-slate-500 mt-3 inline-flex items-start gap-1.5">
        <Info className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          {persistence.note || 'changes are session-only — they reset when you reload'}
          {persistence.overrideCount ? ` · ${persistence.overrideCount} edited` : ''} · areas come from the committed
          roster (backend/config/members.js), not from anything you send.
        </span>
      </p>
    </section>
  );
}
