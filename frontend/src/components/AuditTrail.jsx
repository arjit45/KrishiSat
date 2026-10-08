import React, { useState } from 'react';
import { ListTree, ChevronDown, ChevronRight, Database, Sigma, Target, Fingerprint } from 'lucide-react';
import { fmtPct, fmtMm, fmtWks, fmtSoil, fmtMultiplier, fmtINR, safeNum } from '../lib/formatters';
import { tierLabelOf } from '../constants/severity';

// ─────────────────────────────────────────────────────────────────────────────
// AuditTrail — F5, "How was this calculated?", the product's main trust surface.
//
// Four blocks, in F5's order: data sources (named exactly, with LIVE/FALLBACK
// and the exact value used) → calculation chain → trigger assessment → receipt.
// Every line reads a value the engine published; nothing is recomputed here,
// because a number in this panel that differed from the one the engine used
// would be the exact defect the panel exists to prevent (§P2).
// ─────────────────────────────────────────────────────────────────────────────

function Row({ label, value, note, mark }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-slate-800/70 last:border-0">
      <span className="text-[11px] text-slate-400">
        {label}
        {note ? <span className="text-slate-600"> · {note}</span> : null}
      </span>
      <span className={`text-[11px] font-mono text-slate-200 text-right ${mark === 'fallback' ? 'text-amber-400' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function Block({ icon: Icon, title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-slate-800 rounded-xl bg-slate-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left"
      >
        <span className="inline-flex items-center gap-2 text-[11px] font-bold text-slate-300 uppercase tracking-wider">
          <Icon className="w-3.5 h-3.5 text-emerald-500" /> {title}
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
      </button>
      {open ? <div className="px-4 pb-3">{children}</div> : null}
    </div>
  );
}

const qualityMark = (q) => (q === 'FALLBACK' ? 'fallback' : undefined);
const qualityText = (q) => (q === 'LIVE' ? 'LIVE' : q === 'FALLBACK' ? 'FALLBACK' : q || '—');

const SOURCE_TITLE = {
  openMeteoForecast: 'Open-Meteo Forecast API (trailing precipitation, current soil)',
  openMeteoArchive: 'Open-Meteo Archive API (ERA5-Land soil + archived window)',
  nasaPower: 'NASA POWER 30-year baseline (committed snapshot)',
};

/**
 * @param {{weather:object}} props the full §18.2 payload
 */
export default function AuditTrail({ weather }) {
  const e = weather?.parametricDeficitEngine || {};
  const prov = {
    source: e.baselineSource,
    period: e.baselinePeriod,
    quality: e.baselineQuality,
    monthly: e.baselineMonthlyMm,
    prev: e.baselinePrevMonthMm,
  };
  const sources = weather?.sourceQuality || {};
  const receipt = weather?.receipt;
  const coverage = weather?.durationCoverage;
  const scenario = weather?.scenario || null;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="Calculation audit trail">
      <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-3">
        <ListTree className="w-4 h-4 text-emerald-400" />
        How was this calculated?
        {scenario ? <span className="text-[10px] font-bold text-indigo-300 uppercase">· replay</span> : null}
      </h2>

      <div className="flex flex-col gap-2.5">
        {/* 1 — data sources, named exactly, with status and the value used */}
        <Block icon={Database} title="1. Data sources" defaultOpen>
          {Object.entries(SOURCE_TITLE).filter(([key]) => key in sources).map(([key, title]) => (
            <Row
              key={key}
              label={title}
              value={qualityText(sources[key])}
              mark={qualityMark(sources[key])}
            />
          ))}
          <Row
            label={`Baseline monthly (${prov.period || '—'})`}
            value={`${fmtMm(prov.monthly)} · prev ${fmtMm(prov.prev)}`}
            note={prov.source}
            mark={qualityMark(prov.quality)}
          />
          <Row
            label="Current soil moisture"
            value={fmtSoil(e.soilMoistureRaw)}
            note={e.soilMoistureRawSource || '—'}
            mark={e.soilMoistureRawSource === 'forecast_model' || e.soilMoistureRawSource === 'era5_land_reanalysis' ? undefined : 'fallback'}
          />
          <Row label="Historical soil series" value={e.historicalSoilMoistureSource || '—'} />
          {(weather?.fallbackReasons || []).length > 0 ? (
            <div className="mt-2 text-[10px] text-amber-400/90">
              {weather.fallbackReasons.map((r) => <p key={r}>· {r}</p>)}
            </div>
          ) : null}
        </Block>

        {/* 2 — the calculation chain, each figure as the engine computed it */}
        <Block icon={Sigma} title="2. Calculation chain">
          <Row label="Expected over trailing 30 days" value={fmtMm(e.expected30Mm)} note="climatology" />
          <Row label="Observed over trailing 30 days" value={fmtMm(e.actual30Mm)} />
          <Row label="Rainfall shortfall" value={fmtPct(e.rainfallShortfallPercentage)} note="clamped 0–100" />
          <Row label="Crop stage" value={`${weather?.cropStage?.stageLabel || '—'} (${fmtMultiplier(e.cropStageMultiplier)})`} />
          <Row label="Weighted shortfall index" value={fmtPct(e.weightedShortfallIndex)} note="shortfall × stage weight" />
          <Row label="Soil moisture deficit" value={fmtPct(e.soilMoistureDeficitPercentage)} />
          <Row label="CWSI proxy" value={fmtPct(e.cwsiProxy)} note="banded on FC/wilting point" />
          <Row
            label="Drought duration"
            value={`${fmtWks(e.droughtDurationWeeks)} ${e.durationIsEstimated ? '(estimated)' : '(real)'}`}
            note={e.durationReason || undefined}
            mark={e.durationIsEstimated ? 'fallback' : undefined}
          />
          {coverage ? (
            <Row
              label="Duration window coverage"
              value={`${coverage.soilDaysPresent}/${coverage.windowDays} soil days`}
              note={`last soil ${coverage.lastSoilDate || 'none'}`}
            />
          ) : null}
        </Block>

        {/* 3 — trigger assessment */}
        <Block icon={Target} title="3. Trigger assessment">
          <Row label="Trigger met" value={e.isTriggerMet === true ? 'YES' : e.isTriggerMet === false ? 'no' : 'unknown'} />
          <Row label="Resulting tier" value={tierLabelOf(e.payoutTier)} />
          <Row label="Payout per hectare" value={fmtINR(e.payoutPerHectare)} />
          <Row label="Sum insured applied" value={e.percentSumInsured != null ? `${e.percentSumInsured}% of ₹50,000/ha` : '—'} note="representative demo value" />
          <Row label="Severity" value={e.severityLevel || '—'} />
          <Row label="Aggregate data quality" value={e.dataQuality || '—'} />
          <p className="text-[10px] text-slate-500 mt-2">
            Thresholds and tier logic are decided once, in <code className="text-slate-400">backend/core/ks_core.mjs</code> (§14.2),
            which this page also serves at <a className="text-emerald-500 underline" href="/ks_core.mjs" target="_blank" rel="noreferrer">/ks_core.mjs</a>.
            The frontend never re-derives them.
          </p>
        </Block>

        {/* 4 — the receipt, with a link to the verification view */}
        <Block icon={Fingerprint} title="4. Receipt">
          {receipt ? (
            <>
              <Row label="Receipt id (sha256)" value={`${receipt.receiptId.slice(0, 16)}…`} />
              <Row label="Canonical encoding" value={receipt.canonicalEncoding} />
              <Row label="Issued" value={receipt.createdAt} />
              <p className="text-[10px] text-slate-500 mt-2">
                Reproduce it yourself in the{' '}
                <a className="text-emerald-500 underline" href="#verify-receipt">verification view</a> —
                the browser recomputes this digest from the canonical input below.
              </p>
              <details className="mt-2">
                <summary className="text-[10px] text-slate-400 cursor-pointer">canonical input (what was hashed)</summary>
                <pre className="text-[9px] text-slate-400 bg-slate-950 border border-slate-800 rounded-lg p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all">
                  {receipt.canonicalInput}
                </pre>
              </details>
            </>
          ) : (
            <p className="text-[11px] text-amber-400">
              No receipt: {weather?.parametricDeficitEngine?.dataSource || 'the computation did not complete'}.
            </p>
          )}
        </Block>
      </div>

      {/* §28 disclosures travel with every view; MethodologyNotes renders them. */}
      <p className="text-[10px] text-slate-600 mt-3">
        WSI {fmtPct(safeNum(e.weightedShortfallIndex))} · quality {e.dataQuality || '—'} · every figure above is the
        engine's own published value.
      </p>
    </section>
  );
}
