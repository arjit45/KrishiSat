import React from 'react';
import { Activity, Radio, WifiOff } from 'lucide-react';
import { qualityOf } from '../constants/severity';

// ─────────────────────────────────────────────────────────────────────────────
// Header — brand + the §19.3 data-quality indicator, always visible.
//
// §19.2 label rules apply here in full: no "Orbital Telemetry", no "ORACLE
// LIVE", no claim of on-chain settlement. The three required labels appear
// verbatim: "Open-Meteo ERA5 + NASA POWER", "LIVE TELEMETRY", "Parametric
// Trigger Engine Active".
// ─────────────────────────────────────────────────────────────────────────────

/** Human names for the SourceQuality keys, so PARTIAL can name its component. */
const SOURCE_NAMES = {
  openMeteoForecast: 'Open-Meteo forecast',
  openMeteoArchive: 'Open-Meteo archive',
  nasaPower: 'NASA POWER baseline',
};

function fallbackComponents(sourceQuality) {
  if (!sourceQuality || typeof sourceQuality !== 'object') return [];
  return Object.entries(sourceQuality)
    .filter(([, q]) => q === 'FALLBACK')
    .map(([key]) => SOURCE_NAMES[key] || key);
}

/**
 * @param {{quality?:string, sourceQuality?:object, scenario?:object|null,
 *   coreVersion?:string|null, health?:object|null}} props
 */
export default function Header({ quality, sourceQuality, scenario, coreVersion, health }) {
  const badge = qualityOf(quality);
  const fallbacks = fallbackComponents(sourceQuality);
  const label = scenario
    ? 'SCENARIO — HISTORIC REPLAY'
    : quality === 'PARTIAL' && fallbacks.length
      ? `PARTIAL — ${fallbacks.join(', ')} using fallback`
      : badge.label;

  return (
    <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500 p-2 rounded-xl" style={{ boxShadow: '0 0 20px rgba(16,185,129,0.3)' }}>
            <Activity className="w-6 h-6 text-slate-950" />
          </div>
          <div>
            <h1
              className="text-xl sm:text-2xl font-black tracking-tight"
              style={{ background: 'linear-gradient(90deg,#34d399,#2dd4bf)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
            >
              KrishiSat
            </h1>
            <p className="text-[11px] text-slate-400 font-medium">
              Parametric Agricultural Insurance · Open-Meteo ERA5 + NASA POWER
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* F14 — while a scenario is active it is stated in the header too, so
              no scroll position can hide that these are not current conditions. */}
          {scenario ? (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-full border bg-indigo-950/60 text-indigo-300 border-indigo-800/60"
              title={scenario.banner}
            >
              <Radio className="w-3.3 h-3.3" />
              SCENARIO — HISTORIC REPLAY
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-full border bg-slate-900 border-slate-800 text-slate-300">
              <Radio className="w-3.3 h-3.3" />
              LIVE
            </span>
          )}

          {/* §19.3 — one of LIVE / PARTIAL / OFFLINE, always visible */}
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-full border ${badge.cls}`}
            role="status"
            aria-live="polite"
          >
            {quality === 'OFFLINE' ? <WifiOff className="w-3.5 h-3.5" /> : <span className={`w-2 h-2 rounded-full ${badge.dot}`} />}
            {label}
          </span>

          <span className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full border bg-slate-900 border-slate-800 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Parametric Trigger Engine Active
          </span>

          {coreVersion ? (
            <span className="hidden lg:inline-flex text-[10px] font-mono px-2 py-1 rounded border border-slate-800 bg-slate-900 text-slate-500">
              core {coreVersion}
              {health?.log?.reachable === false ? ' · log n/a' : ''}
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
