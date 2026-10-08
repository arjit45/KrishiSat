import React from 'react';
import { FileText, Download, Printer } from 'lucide-react';
import { fmtPct, fmtINR, fmtWks, fmtMultiplier, fmtDate } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// PlainSummary — F13. A rule-based, deterministic paragraph built only from the
// published payload: no LLM, because an LLM would undermine the determinism the
// product is claiming (§10.2 F13). The export is a CSV of the audit trail plus
// a print-to-PDF path via the browser — no heavy PDF library (§15.11).
// ─────────────────────────────────────────────────────────────────────────────

function summarySentence(weather, scenario) {
  const e = weather?.parametricDeficitEngine || {};
  const d = weather?.district || {};
  const stage = weather?.cropStage || {};

  if (e.weightedShortfallIndex === null || e.weightedShortfallIndex === undefined) {
    return `${d.name || 'This district'} has no computed assessment right now: `
      + `${e.dataSource || 'a required source is unavailable'}. The dashboard is showing what it has and marking the rest.`;
  }

  const severity = String(e.severityLevel || '').toLowerCase().replace(/_/g, ' ');
  const parts = [
    `${d.name || 'This district'} is in ${severity}`,
    `the weighted shortfall index is ${fmtPct(e.weightedShortfallIndex)}`
      + `${stage.label ? ` during the ${stage.label} stage (${fmtMultiplier(e.cropStageMultiplier)} weight)` : ''}`,
    `payout is ${fmtINR(e.payoutPerHectare)} per hectare (${e.percentSumInsured}% of the representative sum insured)`,
    `drought duration ${fmtWks(e.droughtDurationWeeks)}${e.durationIsEstimated ? ' (model-derived estimate; duration clauses disabled)' : ' (counted from archive data)'}`,
    `data quality ${e.dataQuality || 'unknown'}`,
  ];
  const lead = `${parts[0]}. ${parts[1][0].toUpperCase()}${parts[1].slice(1)}, ${parts[2]}, ${parts[3]}, ${parts[4]}.`;
  const mode = scenario
    ? ` This is a historic replay of ${scenario.label} over real archive data, not current conditions.`
    : '';
  return `${lead}${mode}`;
}

/** Audit-trail rows for the CSV: field, value, source/quality. */
function csvRows(weather) {
  const e = weather?.parametricDeficitEngine || {};
  const rows = [
    ['district', weather?.district?.name || ''],
    ['date', weather?.date || ''],
    ['season', weather?.season || ''],
    ['seasonSource', weather?.seasonSource || ''],
    ['mode', weather?.scenario ? `scenario:${weather.scenario.id}` : 'live'],
    ['cropStage', weather?.cropStage?.label || ''],
    ['cropStageMultiplier', e.cropStageMultiplier ?? ''],
    ['baselineMonthlyMm', e.baselineMonthlyMm ?? ''],
    ['baselinePrevMonthMm', e.baselinePrevMonthMm ?? ''],
    ['baselinePeriod', e.baselinePeriod ?? ''],
    ['expected30Mm', e.expected30Mm ?? ''],
    ['actual30Mm', e.actual30Mm ?? ''],
    ['monthToDateMm', e.monthToDateMm ?? ''],
    ['monthToDateExpectedMm', e.monthToDateExpectedMm ?? ''],
    ['rainfallShortfallPercentage', e.rainfallShortfallPercentage ?? ''],
    ['soilMoistureRaw', e.soilMoistureRaw ?? ''],
    ['soilMoistureRawSource', e.soilMoistureRawSource ?? ''],
    ['fieldCapacity', e.fieldCapacity ?? ''],
    ['wiltingPoint', e.wiltingPoint ?? ''],
    ['soilMoistureDeficitPercentage', e.soilMoistureDeficitPercentage ?? ''],
    ['cwsiProxy', e.cwsiProxy ?? ''],
    ['weightedShortfallIndex', e.weightedShortfallIndex ?? ''],
    ['droughtDurationWeeks', e.droughtDurationWeeks ?? ''],
    ['durationIsEstimated', e.durationIsEstimated ?? ''],
    ['isTriggerMet', e.isTriggerMet ?? ''],
    ['severityLevel', e.severityLevel ?? ''],
    ['payoutTier', e.payoutTier ?? ''],
    ['payoutPerHectare', e.payoutPerHectare ?? ''],
    ['percentSumInsured', e.percentSumInsured ?? ''],
    ['dataQuality', e.dataQuality ?? ''],
    ['receiptId', weather?.receipt?.receiptId ?? ''],
    ['canonicalEncoding', weather?.receipt?.canonicalEncoding ?? ''],
  ];
  return rows;
}

function downloadCsv(weather) {
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = ['field,value', ...csvRows(weather).map(([k, v]) => `${esc(k)},${esc(v)}`)].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `krishisat-${weather?.district?.id || 'district'}-${weather?.date || 'assessment'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function PlainSummary({ weather, scenario }) {
  const e = weather?.parametricDeficitEngine || {};

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Plain-language summary">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <FileText className="w-4 h-4 text-emerald-400" /> In plain language
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => downloadCsv(weather)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-slate-200 bg-slate-800 hover:bg-slate-700 transition-colors"
            title="Download the audit trail as CSV"
          >
            <Download className="w-3 h-3" /> CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-slate-200 bg-slate-800 hover:bg-slate-700 transition-colors"
            title="Print or save as PDF"
          >
            <Printer className="w-3 h-3" /> Print / PDF
          </button>
        </div>
      </div>

      <p className="text-[13px] leading-relaxed text-slate-300 mt-3">{summarySentence(weather, scenario)}</p>

      <p className="text-[10px] text-slate-600 mt-3">
        Deterministic sentence built from the published payload ({fmtDate(weather?.date)} assessment) — no generated text,
        so the same numbers always produce the same paragraph.
        {e.isTriggerMet === false ? ' Payout figures are recommendations, not a settlement.' : ''}
      </p>
    </section>
  );
}
