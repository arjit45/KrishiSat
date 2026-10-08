// ─────────────────────────────────────────────────────────────────────────────
// Display mapping ONLY — PRD §19.1 (colours), §19.2 (labels), §20.2 boundary
// rule: "constants/severity.js holds display mapping only. Thresholds and tier
// logic exist once, in the core/backend. The frontend MUST NOT re-derive tiers."
//
// Nothing here decides anything: every value this file maps is a string the API
// already computed (severityLevel, payoutTier, dataQuality). If an unknown value
// arrives, the components fall back to a neutral display rather than guessing.
// ─────────────────────────────────────────────────────────────────────────────

/** §19.1 severity → colour, always paired with text (never colour alone). */
export const SEVERITY = Object.freeze({
  NORMAL: { label: 'Normal conditions', dot: '#10b981', cls: 'text-emerald-400', badge: 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50' },
  MODERATE_DEFICIT: { label: 'Moderate deficit', dot: '#f59e0b', cls: 'text-amber-400', badge: 'bg-amber-950/60 text-amber-400 border-amber-800/50' },
  SEVERE_DROUGHT: { label: 'Severe drought', dot: '#f97316', cls: 'text-orange-400', badge: 'bg-orange-950/60 text-orange-400 border-orange-800/50' },
  CATASTROPHIC_DROUGHT: { label: 'Catastrophic drought', dot: '#ef4444', cls: 'text-red-400', badge: 'bg-red-950/60 text-red-400 border-red-800/50' },
  PREVENTED_SOWING: { label: 'Prevented sowing', dot: '#3b82f6', cls: 'text-blue-400', badge: 'bg-blue-950/60 text-blue-400 border-blue-800/50' },
});

export const SEVERITY_FALLBACK = { label: 'Unknown', dot: '#64748b', cls: 'text-slate-400', badge: 'bg-slate-900 text-slate-400 border-slate-700' };

/** Payout tier id → display label. The tier itself is decided in the core. */
export const TIER_LABEL = Object.freeze({
  BELOW_THRESHOLD: 'Below threshold',
  PREVENTED_SOWING: 'Prevented sowing',
  TIER_1_MODERATE: 'Tier 1 — Moderate',
  TIER_2_SEVERE: 'Tier 2 — Severe',
  TIER_3_CATASTROPHIC: 'Tier 3 — Catastrophic',
});

export const TIER_FALLBACK = '—';

/** §19.3 header badge: colour and wording for each AggregateQuality. */
export const QUALITY_BADGE = Object.freeze({
  LIVE: { label: 'LIVE DATA', cls: 'text-emerald-400 bg-emerald-950/60 border-emerald-800/50', dot: 'bg-emerald-400' },
  PARTIAL: { label: 'PARTIAL — component using fallback', cls: 'text-amber-400 bg-amber-950/60 border-amber-800/50', dot: 'bg-amber-400' },
  OFFLINE: { label: 'OFFLINE — all data from fallback', cls: 'text-red-400 bg-red-950/60 border-red-800/50', dot: 'bg-red-400' },
});

export const QUALITY_FALLBACK = { label: 'UNKNOWN', cls: 'text-slate-400 bg-slate-900 border-slate-700', dot: 'bg-slate-500' };

export function severityOf(level) {
  return SEVERITY[level] || SEVERITY_FALLBACK;
}

export function tierLabelOf(tier) {
  return TIER_LABEL[tier] ?? TIER_FALLBACK;
}

export function qualityOf(quality) {
  return QUALITY_BADGE[quality] || QUALITY_FALLBACK;
}
