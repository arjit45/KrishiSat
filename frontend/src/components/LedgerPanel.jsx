import React from 'react';
import { ScrollText, Info } from 'lucide-react';
import { tierLabelOf } from '../constants/severity';
import { fmtINR, fmtHa } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// LedgerPanel — F7, the Demo Settlement Log.
//
// Labelled exactly as F7/§19.2 require ("Demo Settlement Log — Simulated, not
// real transactions"), never as a smart contract or settled money. Entries are
// the §18.4 body — causal (only triggering districts), drawn from the F12
// roster, and byte-identical across reloads. An empty ledger explains itself via
// the server's X-Ledger-Note rather than looking broken (§27).
// ─────────────────────────────────────────────────────────────────────────────

export default function LedgerPanel({ ledger, loading, scenario }) {
  const entries = ledger?.entries || [];
  const label = ledger?.label || 'Demo Settlement Log — Simulated, not real transactions';
  const note = ledger?.note;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Demo settlement log">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-emerald-400" />
            Demo Settlement Log — Simulated, not real transactions
          </h2>
          <p className="text-[10px] text-slate-500 mt-1">
            {scenario
              ? `Historic replay: ${scenario.label} — the roster settling the scenario's own district and day.`
              : 'Causal: entries exist only for districts currently meeting a payout trigger.'}
          </p>
        </div>
        <span className="text-[10px] font-mono text-slate-600 shrink-0">{entries.length} entries</span>
      </div>

      <div className="space-y-2 overflow-y-auto" style={{ maxHeight: '340px' }}>
        {loading && entries.length === 0 ? (
          <p className="text-xs text-slate-500 italic py-6 text-center">Loading the log…</p>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-5 text-center">
            <p className="text-xs text-slate-400 font-semibold">
              {note || 'No payout trigger in this window — the ledger is empty, by design.'}
            </p>
            <p className="text-[10px] text-slate-600 mt-1 inline-flex items-center gap-1 justify-center">
              <Info className="w-3 h-3" />
              A non-triggering district contributes no entries; nothing is substituted for one (§14.5).
            </p>
          </div>
        ) : (
          entries.map((entry, idx) => (
            <div
              key={`${entry.memberRef}-${entry.timestamp}-${idx}`}
              className="rounded-xl px-3 py-2.5 flex justify-between items-center gap-3 bg-slate-950/60 border border-slate-800"
            >
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-200 truncate">{entry.memberRef}</p>
                <p className="text-[10px] text-slate-500 truncate">{entry.cooperative}</p>
                <p className="text-[10px] text-slate-600 truncate">
                  {tierLabelOf(entry.tier)} · {entry.triggerIndex} · {entry.cropStage} · {fmtHa(entry.hectares)}
                </p>
                <p className="text-[9px] text-slate-700 mt-0.5 font-mono">{entry.timestamp}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-black text-emerald-400">{fmtINR(entry.amount)}</p>
                <span className="inline-block text-[9px] font-bold text-amber-400 bg-amber-950/50 border border-amber-800/50 px-1.5 py-0.5 rounded-full mt-0.5">
                  SIMULATED
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {label ? (
        <p className="text-[9px] text-slate-600 mt-3 font-mono break-all">server label: {label}</p>
      ) : null}
    </section>
  );
}
