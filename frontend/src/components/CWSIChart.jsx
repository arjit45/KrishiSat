import React from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Filler,
} from 'chart.js';
import { AlertTriangle } from 'lucide-react';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Filler);

// ─────────────────────────────────────────────────────────────────────────────
// CWSIChart — F4. The chart is fed ONLY the five points the engine published
// (§18.2 `cwsiTrend` / `cwsiTrendPoints`); this file computes nothing (§14.4 —
// the NDVI proxy that used to be derived here from shortfall is deleted, not
// ported). Titles and axis wording follow F4 exactly, including the label that
// says what the index is derived from.
// ─────────────────────────────────────────────────────────────────────────────

export default function CWSIChart({ weather }) {
  const points = Array.isArray(weather?.cwsiTrendPoints) ? weather.cwsiTrendPoints : [];
  const trend = Array.isArray(weather?.cwsiTrend) ? weather.cwsiTrend : [];
  const spliced = new Set(weather?.cwsiTrendSplicedDates || []);
  const truncated = new Set(weather?.cwsiTrendTruncatedDates || []);
  const scenario = weather?.scenario || null;
  const historicalLabel = 'ERA5-Land reanalysis (historical)';
  const currentLabel = scenario
    ? 'ERA5-Land archive daily mean (replay current point)'
    : 'forecast-model soil moisture (current)';

  if (trend.length === 0) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-bold text-slate-200">Crop Water Stress Index (CWSI) — 4-Week Trend</h2>
        <p className="text-xs text-amber-400 mt-3 inline-flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          No trend points available — the soil-moisture source did not answer for this window.
        </p>
      </section>
    );
  }

  const labels = trend.map((_, i) => {
    const p = points[i];
    if (!p) return i === trend.length - 1 ? 'now' : `−${(trend.length - 1 - i) * 7} d`;
    return i === trend.length - 1 && p.date === points[points.length - 1]?.date && weather?.date === p.date
      ? 'now'
      : p.date.slice(5); // MM-DD
  });

  const data = {
    labels,
    datasets: [{
      label: 'CWSI',
      data: trend,
      borderColor: 'rgb(245,158,11)',
      backgroundColor: 'rgba(245,158,11,0.08)',
      fill: true,
      tension: 0.3,
      spanGaps: false,
      pointRadius: trend.map((_, i) => (points[i] && truncated.has(points[i].date) ? 2 : 5)),
      pointBackgroundColor: trend.map((_, i) => {
        const date = points[i]?.date;
        if (date && spliced.has(date)) return 'rgba(56,189,248,1)'; // spliced point
        if (date && truncated.has(date)) return 'rgba(100,116,139,0.6)'; // truncated marker
        return 'rgb(245,158,11)';
      }),
      pointBorderColor: trend.map((_, i) => {
        const date = points[i]?.date;
        return date && spliced.has(date) ? 'rgba(56,189,248,0.5)' : 'rgba(245,158,11,0.4)';
      }),
    }],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: false },
      tooltip: {
        callbacks: {
          afterLabel: (ctx) => {
            const p = points[ctx.dataIndex];
            if (!p) return '';
            const notes = [];
            if (p.source) notes.push(p.source);
            if (p.date && spliced.has(p.date)) notes.push('spliced from forecast series');
            if (p.date && truncated.has(p.date)) notes.push('no source available — omitted');
            return notes;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#94a3b8', font: { size: 10 } },
        grid: { color: '#1e293b' },
      },
      y: {
        min: 0,
        max: 1,
        ticks: { color: '#94a3b8', font: { size: 10 } },
        grid: { color: '#1e293b' },
        title: { display: true, text: 'CWSI (0 = no stress, 1 = max stress)', color: '#94a3b8', font: { size: 10 } },
      },
    },
  };

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Crop Water Stress Index chart">
      <div className="flex justify-between items-start gap-3 mb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-200">Crop Water Stress Index (CWSI) — 4-Week Trend</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Derived from {historicalLabel} soil moisture (historical) and {currentLabel} — not satellite thermal imagery.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[9px] text-slate-500 shrink-0">
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> archive</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" /> spliced</span>
        </div>
      </div>
      <div style={{ height: '200px' }}>
        <Line data={data} options={options} />
      </div>
    </section>
  );
}
