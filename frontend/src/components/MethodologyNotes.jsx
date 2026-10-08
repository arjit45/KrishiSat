import React from 'react';
import { BookOpen } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// MethodologyNotes — §28's disclosure section, which the dashboard MUST carry.
//
// The list comes from the API payload (`methodologyNotes` + `attribution`), so
// the disclosures are the backend's own wording and cannot drift from the code
// that they describe. A scenario response carries an additional note about its
// replay sources (§28, F14).
// ─────────────────────────────────────────────────────────────────────────────

export default function MethodologyNotes({ weather }) {
  const notes = Array.isArray(weather?.methodologyNotes) ? weather.methodologyNotes : [];
  const attribution = Array.isArray(weather?.attribution) ? weather.attribution : [];

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Methodology notes and limitations">
      <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-3">
        <BookOpen className="w-4 h-4 text-emerald-400" />
        Methodology notes &amp; limitations
      </h2>

      {notes.length === 0 ? (
        <p className="text-xs text-slate-500">No notes published for this response.</p>
      ) : (
        <ol className="list-decimal list-inside space-y-1.5">
          {notes.map((note, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-slate-400">{note}</li>
          ))}
        </ol>
      )}

      <div className="mt-4 pt-3 border-t border-slate-800">
        <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Attribution</p>
        <ul className="space-y-1">
          {attribution.map((line, i) => (
            <li key={i} className="text-[10px] text-slate-500">{line}</li>
          ))}
        </ul>
      </div>

      <p className="text-[10px] text-slate-600 mt-3">
        This platform is a decision-support tool, not a licensed insurance product; all payout figures
        are recommendations. No copy in this product claims settlement of real money or on-chain execution (§19.2).
      </p>
    </section>
  );
}
