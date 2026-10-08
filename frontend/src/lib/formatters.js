// ─────────────────────────────────────────────────────────────────────────────
// Presentational formatting ONLY — PRD §20.2. No thresholds, no tier logic, no
// derivation of any figure: every function here takes a number the API published
// and renders it. `safeNum` exists so a null (a source that failed) reads as "—"
// rather than silently becoming 0, because "we do not know" and "there is none"
// are different claims (§16.2).
// ─────────────────────────────────────────────────────────────────────────────

const hasNumber = (v) => typeof v === 'number' && Number.isFinite(v);

export const safeNum = (v, fallback = null) => (hasNumber(v) ? v : fallback);

/** ₹ with Indian digit grouping; `null` renders as an em dash, never as ₹0. */
export const fmtINR = (n) => (hasNumber(n) ? `₹${Math.round(n).toLocaleString('en-IN')}` : '—');

export const fmtPct = (n, dp = 1) => (hasNumber(n) ? `${n.toFixed(dp)}%` : '—');

export const fmtWks = (n) => (hasNumber(n) ? `${n.toFixed(n % 1 ? 1 : 0)} wk${n === 1 ? '' : 's'}` : '—');

export const fmtMm = (n) => (hasNumber(n) ? `${n.toFixed(1)} mm` : '—');

export const fmtCwsi = (n) => (hasNumber(n) ? n.toFixed(2) : '—');

export const fmtHa = (n) => (hasNumber(n) ? `${n.toFixed(2).replace(/\.00$/, '')} ha` : '—');

/** m³/m³ soil moisture at source precision. */
export const fmtSoil = (n) => (hasNumber(n) ? n.toFixed(3) : '—');

export const fmtMultiplier = (n) => (hasNumber(n) ? `${n.toFixed(1)}×` : '—');

/** 2026-10-08 → 8 Oct 2026, without a locale dependency (§F7 determinism spirit). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '—';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
