import React, { useState } from 'react';
import { Fingerprint, ShieldCheck, ShieldX, Loader2, Server } from 'lucide-react';
import { verifyReceipt } from '../lib/coreClient';
import { api } from '../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// ReceiptVerify — F10. "Reproduce a payout in your own browser" is the product's
// central claim, so the view does the whole job:
//
//   1. assert the served core module hashes to the API's published
//      coreChecksum (§15.8) — a recompute against unasserted code would be a
//      false guarantee, so this runs first and can FAIL loudly;
//   2. recompute sha256 over the published canonical input and compare with the
//      published receiptId, reporting MATCH or MISMATCH;
//   3. optionally cross-check the same pair against POST /api/verify-receipt so
//      the reader can see browser and server agree.
//
// Nothing here trusts the receipt on offer: the whole point is that a mismatch
// is reported, not smoothed over.
// ─────────────────────────────────────────────────────────────────────────────

export default function ReceiptVerify({ receipt, weather }) {
  const [state, setState] = useState({ status: 'idle' });
  const [serverState, setServerState] = useState({ status: 'idle' });

  const hasReceipt = Boolean(receipt && receipt.receiptId);

  async function runVerify() {
    setState({ status: 'running' });
    const result = await verifyReceipt(receipt);
    setState({ status: 'done', result });
  }

  async function runServerCheck() {
    setServerState({ status: 'running' });
    try {
      const res = await api.verifyReceipt(receipt.receiptId, receipt.canonicalInput);
      setServerState({ status: 'done', res });
    } catch (err) {
      setServerState({ status: 'error', message: err.message });
    }
  }

  if (!hasReceipt) {
    return (
      <section id="verify-receipt" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Fingerprint className="w-4 h-4 text-emerald-400" /> Verify this receipt in your browser
        </h2>
        <p className="text-xs text-amber-400 mt-3">
          No receipt to verify — this response did not complete a computation
          {weather?.parametricDeficitEngine?.dataSource ? ` (${weather.parametricDeficitEngine.dataSource})` : ''}.
        </p>
      </section>
    );
  }

  return (
    <section id="verify-receipt" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
        <Fingerprint className="w-4 h-4 text-emerald-400" /> Verify this receipt in your browser
      </h2>
      <p className="text-[11px] text-slate-500 mt-1">
        The browser fetches <code className="text-slate-400">/ks_core.mjs</code>, asserts its hash against the API's
        published <code className="text-slate-400">coreChecksum</code> (§15.8), then recomputes sha256 over the
        canonical input below and compares it with the published receipt id.
      </p>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          type="button"
          onClick={runVerify}
          disabled={state.status === 'running'}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 transition-colors"
        >
          {state.status === 'running' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
          {state.status === 'running' ? 'Checking…' : 'Verify in this browser'}
        </button>

        <button
          type="button"
          onClick={runServerCheck}
          disabled={serverState.status === 'running'}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 transition-colors"
        >
          <Server className="w-3.5 h-3.5" />
          Cross-check on the server
        </button>

        <span className="text-[10px] font-mono text-slate-500">
          {receipt.receiptId.slice(0, 24)}…
        </span>
      </div>

      {state.status === 'done' ? (
        <div
          className={`mt-3 rounded-xl border px-4 py-3 ${
            state.result.ok
              ? 'bg-emerald-950/40 border-emerald-800/60'
              : 'bg-red-950/40 border-red-800/60'
          }`}
          role="status"
          aria-live="polite"
        >
          <p className={`text-sm font-black flex items-center gap-2 ${state.result.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {state.result.ok ? <ShieldCheck className="w-4 h-4" /> : <ShieldX className="w-4 h-4" />}
            {state.result.ok ? 'MATCH' : 'MISMATCH'}
          </p>
          <p className="text-[11px] text-slate-300 mt-1">{state.result.reason}</p>
          <div className="text-[10px] font-mono text-slate-500 mt-2 space-y-0.5">
            <p>recomputed: {state.result.digest || '—'}</p>
            <p>published: {receipt.receiptId}</p>
            <p>core: {state.result.coreVersion || '—'} · checksum {state.result.coreChecksum ? `${state.result.coreChecksum.slice(0, 26)}…` : '—'}</p>
          </div>
        </div>
      ) : null}

      {serverState.status === 'done' ? (
        <p className="text-[11px] text-slate-400 mt-2">
          Server cross-check:{' '}
          <span className={serverState.res.match ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
            {serverState.res.match ? 'agrees (match)' : 'DISAGREES'}
          </span>
          {' '}— server recomputed {String(serverState.res.recomputedReceiptId).slice(0, 24)}…
        </p>
      ) : null}
      {serverState.status === 'error' ? (
        <p className="text-[11px] text-amber-400 mt-2">Server cross-check unavailable: {serverState.message}</p>
      ) : null}
    </section>
  );
}
