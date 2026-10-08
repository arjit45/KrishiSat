// ─────────────────────────────────────────────────────────────────────────────
// API wrappers — PRD §20.2, §18, §21.1.
//
// One place builds URLs and one place reads response shapes, so a route change
// is a single edit rather than a hunt through components. `VITE_API_URL` is the
// §21.1 variable; in production the browser calls its own origin (§21.2), so the
// default is the empty base. Local dev falls back to the backend's default port
// because Vite serves on 5173.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:5000' : ''))
  .replace(/\/+$/, '');

export const API = BASE;

/** Query-string builder that drops empty values, so `?season=` never appears. */
export function qs(params = {}) {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

async function request(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body && (body.error || body.detail)) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

const get = (path) => request(path);
const post = (path, payload) => request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload ?? {}),
});

export const api = {
  health: () => get('/api/health'),
  districts: (season) => get(`/api/districts${qs({ season })}`),
  weather: (district, { season, scenario } = {}) =>
    get(`/api/weather/${encodeURIComponent(district)}${qs({ season, scenario })}`),
  scenarios: () => get('/api/scenarios'),
  ledger: ({ season, scenario } = {}) => get(`/api/ledger${qs({ season, scenario })}`),
  // §18.3 body: the engine's own inputs, never a client-side tier decision.
  payout: (body) => post('/api/calculate-payout', body),
  cooperatives: (district, { season, scenario } = {}) =>
    get(`/api/cooperatives/${encodeURIComponent(district)}${qs({ season, scenario })}`),
  saveHectares: (district, overrides, { season, scenario } = {}) =>
    post(`/api/cooperatives/${encodeURIComponent(district)}${qs({ season, scenario })}`, { overrides }),
  backtest: (district) => get(`/api/backtest/${encodeURIComponent(district)}`),
  recommendations: ({ district, from, to, limit } = {}) =>
    get(`/api/recommendations${qs({ district, from, to, limit })}`),
  verifyReceipt: (receiptId, canonicalInput) => post('/api/verify-receipt', { receiptId, canonicalInput }),
  coreSource: () => fetch(`${BASE}/ks_core.mjs`).then((r) => {
    if (!r.ok) throw new Error(`core module HTTP ${r.status}`);
    return r.text();
  }),
};

/** Read the HTTP-only labelling headers §18.4 attaches to the ledger body. */
export async function fetchLedger(params) {
  const res = await fetch(`${BASE}/api/ledger${qs(params)}`);
  const entries = res.ok ? await res.json() : [];
  return {
    entries: Array.isArray(entries) ? entries : [],
    label: res.headers.get('x-ledger-label'),
    note: res.headers.get('x-ledger-note'),
    status: res.status,
  };
}
