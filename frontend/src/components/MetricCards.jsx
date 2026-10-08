import React from 'react';
import { CloudRain, Droplet, Timer, Gauge, AlertTriangle } from 'lucide-react';
import { fmtPct, fmtMm, fmtWks, fmtSoil, safeNum } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// MetricCards — the headline numbers of the §18.2 payload, each with its source
// and, when a source failed, its own fallback marker (§19.3).
//
// No figure is computed here. Where the API published null, the card shows
// "unavailable" — never a substituted zero, because "we do not know" and "there
// is none" must not share a number (§16.2).
// ─────────────────────────────────────────────────────────────────────────────

function Card({ icon: Icon, iconColor, label, value, sub, subColor, missing, missingNote }) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex flex-col gap-1.5">
      <div className="flex justify-between items-center gap-2">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{label}</p>
        <Icon className={`w-4 h-4 shrink-0 ${iconColor || 'text-slate-400'}`} />
      </div>
      {missing ? (
        <>
          <p className="text-2xl font-black text-slate-600">unavailable</p>
          <p className="text-[10px] font-semibold text-amber-500 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {missingNote || 'source fallback — value not substituted'}
          </p>
        </>
      ) : (
        <>
          <p className="text-2xl font-black text-slate-100">{value}</p>
          <p className={`text-[10px] font-medium ${subColor || 'text-slate-500'}`}>{sub}</p>
        </>
      )}
    </div>
  );
}

/**
 * @param {{weather:object}} props the full §18.2 payload
 */
export default function MetricCards({ weather }) {
  const e = weather?.parametricDeficitEngine || {};
  const sources = weather?.sourceQuality || {};
  const forecastFallback = sources.openMeteoForecast === 'FALLBACK' || sources.openMeteoArchive === 'FALLBACK';

  const shortfall = safeNum(e.rainfallShortfallPercentage);
  const soilDeficit = safeNum(e.soilMoistureDeficitPercentage);
  const weeks = safeNum(e.droughtDurationWeeks);
  const wsi = safeNum(e.weightedShortfallIndex);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <Card
        icon={CloudRain}
        iconColor="text-sky-400"
        label="Rainfall shortfall (trailing 30 d)"
        missing={shortfall === null}
        missingNote={forecastFallback ? 'precipitation source fallback' : undefined}
        value={fmtPct(shortfall)}
        sub={`month-to-date ${fmtMm(e.monthToDateMm)} vs ${fmtMm(e.monthToDateExpectedMm)} expected`}
        subColor={shortfall !== null && shortfall > 30 ? 'text-rose-400' : undefined}
      />
      <Card
        icon={Droplet}
        iconColor="text-teal-400"
        label="Soil moisture deficit"
        missing={soilDeficit === null}
        value={fmtPct(soilDeficit)}
        sub={`θ ${fmtSoil(e.soilMoistureRaw)} m³/m³ · ${e.soilMoistureRawSource || '—'}`}
      />
      <Card
        icon={Timer}
        iconColor="text-amber-400"
        label="Drought duration"
        missing={weeks === null}
        value={fmtWks(weeks)}
        sub={e.durationIsEstimated
          ? `estimated — ${e.durationReason || 'window not fully covered'}; OR-clauses off`
          : 'real — counted from archive data (§12.3)'}
        subColor={e.durationIsEstimated ? 'text-amber-500' : 'text-emerald-500'}
      />
      <Card
        icon={Gauge}
        iconColor="text-rose-400"
        label="Weighted shortfall index"
        missing={wsi === null}
        value={fmtPct(wsi)}
        sub={`shortfall × ${e.cropStageMultiplier ?? '—'} stage weight`}
        subColor={wsi !== null && wsi >= 50 ? 'text-rose-400' : undefined}
      />
    </div>
  );
}
