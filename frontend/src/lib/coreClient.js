// ─────────────────────────────────────────────────────────────────────────────
// F10 verification client — PRD §10.2 F10, §15.8.
//
// Two steps, in this order, because the order is the point:
//
//   1. CHECKSUM ASSERTION. Fetch /ks_core.mjs — the SINGLE served location
//      (§20.1) — hash those exact bytes and compare with the `coreChecksum` the
//      API published. An unasserted recompute against different code would be a
//      false guarantee, which is why this runs BEFORE anything is reported.
//
//   2. RECOMPUTE. SHA-256 over the published canonical input, compared with the
//      published receiptId. The digest is the platform's SHA-256 because a
//      browser has no other; §22.1 pins the core's integer-only SHA-256 to this
//      same digest (core.test.mjs), so the two cannot disagree — and the core's
//      `_internals` are test-only and forbidden on a product path (§14.2).
//
// The imported module is also version-reported with the verdict, so a MATCH
// always names the code it was checked against.
// ─────────────────────────────────────────────────────────────────────────────

import { API, api } from './api';

const encoder = new TextEncoder();

async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cached { source, checksum, core } for the session; re-asserted every load. */
let corePromise = null;

async function importCore(source, cacheKey) {
  // Cache-busted so a checksum change cannot serve a stale module (§15.8).
  const url = `${API}/ks_core.mjs?verify=${encodeURIComponent(cacheKey)}`;
  return import(/* @vite-ignore */ url);
}

/**
 * Load the served core and assert its bytes against the API's published
 * checksum. Rejects — rather than quietly continuing — when they differ.
 *
 * @returns {Promise<{core:object, checksum:string, coreVersion:string}>}
 */
export async function loadVerifiedCore() {
  if (corePromise) return corePromise;

  corePromise = (async () => {
    const [source, health] = await Promise.all([api.coreSource(), api.health()]);
    const checksum = `sha256:${await sha256Hex(encoder.encode(source))}`;

    if (!health.coreChecksum) {
      throw new Error('The API published no coreChecksum (§15.8), so nothing can be verified against it.');
    }
    if (checksum !== health.coreChecksum) {
      throw new Error(
        `Core checksum mismatch: the served module (${checksum}) is not the one the API computed with `
        + `(${health.coreChecksum}). Do not trust this receipt until this is resolved.`,
      );
    }

    const core = await importCore(source, checksum);
    if (!core || typeof core.ksReceipt !== 'function') {
      throw new Error('The served module did not expose ksReceipt — wrong file served.');
    }
    return { core, checksum, coreVersion: core.KS_VERSION ?? health.coreVersion ?? null };
  })();

  // A failed assertion must not be cached for the session.
  corePromise.catch(() => { corePromise = null; });
  return corePromise;
}

/**
 * Verify one published receipt in the browser (F10).
 *
 * @param {{receiptId:string, canonicalInput:string, canonicalEncoding?:string, algorithm?:string}} receipt
 * @returns {Promise<{ok:boolean, digest:string, reason:string, coreChecksum:string, coreVersion:string|null}>}
 */
export async function verifyReceipt(receipt) {
  if (!receipt || typeof receipt.canonicalInput !== 'string' || typeof receipt.receiptId !== 'string') {
    return {
      ok: false,
      digest: '',
      reason: 'This response carries no receipt to verify.',
      coreChecksum: '',
      coreVersion: null,
    };
  }
  if (receipt.algorithm && receipt.algorithm !== 'sha256') {
    return {
      ok: false, digest: '', reason: `Unsupported algorithm "${receipt.algorithm}".`, coreChecksum: '', coreVersion: null,
    };
  }
  if (receipt.canonicalEncoding && receipt.canonicalEncoding !== 'scaled-int-v1') {
    return {
      ok: false,
      digest: '',
      reason: `Unsupported canonical encoding "${receipt.canonicalEncoding}".`,
      coreChecksum: '',
      coreVersion: null,
    };
  }

  try {
    const { checksum, coreVersion } = await loadVerifiedCore();
    const digest = await sha256Hex(receipt.canonicalInput);
    const ok = digest === receipt.receiptId;
    return {
      ok,
      digest,
      reason: ok
        ? 'The published canonical input hashes to exactly the published receipt id.'
        : 'The published canonical input does NOT hash to the published receipt id.',
      coreChecksum: checksum,
      coreVersion,
    };
  } catch (err) {
    return {
      ok: false,
      digest: '',
      reason: err.message,
      coreChecksum: '',
      coreVersion: null,
    };
  }
}
