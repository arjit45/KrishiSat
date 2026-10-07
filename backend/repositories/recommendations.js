'use strict';

/**
 * The ONLY module permitted to import a database client (PRD §14.5).
 *
 * Rules this file exists to enforce, and which a reviewer can check here and
 * nowhere else:
 *
 *   1. One importer. Routes, engines, services and components must not require a
 *      database client. If you are adding one, you are adding a defect.
 *   2. The store is a LEAF. Data flows out of the engine into it; nothing flows
 *      back. Nothing here is importable by the index math, which is what makes
 *      "the log is output, never input" (F15) an architectural fact rather than
 *      a convention.
 *   3. The read path never throws. Every function resolves to a structured
 *      result, because a database outage must degrade a history panel and
 *      nothing else (§16.2).
 *   4. Credentials live only here and only server-side (§15.7). Nothing in this
 *      file may be reached from the browser bundle.
 *
 * Column names are snake_case in Postgres and camelCase in the contract (§11.9).
 * The translation lives in the two mappers below and nowhere else, so a naming
 * mismatch surfaces in one file instead of across the codebase.
 */

const TABLE = 'recommendation_log';

const COLUMNS = [
    'id',
    'district',
    'log_date',
    'season',
    'scenario_id',
    'wsi',
    'payout_tier',
    'payout_per_hectare',
    'severity_level',
    'aggregate_quality',
    'duration_mode',
    'canonical_input_hash',
    'receipt_id',
    'created_at',
].join(', ');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// A cron interval of one day (§21.2) plus a margin. Beyond this the log has
// stopped appending and the product's "and when" claim is quietly untrue (§17).
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

// Every query is bounded, so a slow or unreachable database can never hold a
// request open. This is the mechanism behind "the database is never on the
// critical read path" (§16.2) — the claim is only true if it is enforced here.
const QUERY_TIMEOUT_MS = 3000;

/** Physical row → contract shape (§11.9). */
function toContract(row) {
    return {
        id: row.id,
        district: row.district,
        date: row.log_date,
        season: row.season,
        scenarioId: row.scenario_id,
        wsi: row.wsi === null ? null : Number(row.wsi),
        payoutTier: row.payout_tier,
        payoutPerHectare: row.payout_per_hectare,
        severityLevel: row.severity_level,
        aggregateQuality: row.aggregate_quality,
        durationMode: row.duration_mode,
        canonicalInputHash: row.canonical_input_hash,
        receiptId: row.receipt_id,
        createdAt: row.created_at,
    };
}

/** Contract shape (§11.9) → physical row. */
function toRow(entry) {
    return {
        district: entry.district,
        log_date: entry.date,
        season: entry.season,
        scenario_id: entry.scenarioId ?? null,
        wsi: entry.wsi,
        payout_tier: entry.payoutTier,
        payout_per_hectare: entry.payoutPerHectare,
        severity_level: entry.severityLevel,
        aggregate_quality: entry.aggregateQuality,
        duration_mode: entry.durationMode,
        canonical_input_hash: entry.canonicalInputHash,
        receipt_id: entry.receiptId,
    };
}

let client = null;
let clientUnavailable = false;

/**
 * Lazily build the client. Lazy for two reasons: an absent configuration must
 * not crash a cold start, and this module is importable in tests that have no
 * database at all.
 */
function getClient() {
    if (client) return client;
    if (clientUnavailable) return null;

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        clientUnavailable = true;
        return null;
    }

    // Required here, not at module scope: keeps the dependency off the require
    // graph of every consumer of this file.
    const { createClient } = require('@supabase/supabase-js');

    const boundedFetch = (input, init = {}) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });

    client = createClient(url, key, {
        global: { fetch: boundedFetch },
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
}

function isConfigured() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Append one recommendation. Idempotent on `canonicalInputHash`: re-running the
 * job for an unchanged input inserts nothing and is not an error (F15).
 */
async function append(entry) {
    const db = getClient();
    if (!db) return { stored: false, reason: 'not-configured' };

    try {
        const { data, error } = await db
            .from(TABLE)
            .insert(toRow(entry))
            .select('id, canonical_input_hash')
            .limit(1);

        if (error) {
            // 23505 = unique_violation. Already logged: the intended no-op.
            if (error.code === '23505') return { stored: false, duplicate: true };
            return { stored: false, reason: error.message };
        }

        const row = Array.isArray(data) ? data[0] : null;
        return { stored: true, id: row ? row.id : null };
    } catch (err) {
        return { stored: false, reason: err && err.message ? err.message : 'unexpected error' };
    }
}

function encodeCursor(entry) {
    return Buffer.from(`${entry.created_at}|${entry.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
    try {
        const [createdAt, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
        if (!createdAt || !id) return null;
        return { createdAt, id };
    } catch {
        return null;
    }
}

/**
 * Read the log, newest first. Returns `{ available, entries, nextCursor, reason }`
 * and never throws: an unreachable log resolves to `available: false` with an
 * empty list, which the UI renders as the §19.4 empty-with-reason state (§18.9).
 */
async function list({ district, from, to, limit, cursor } = {}) {
    const db = getClient();
    if (!db) return { available: false, entries: [], nextCursor: null, reason: 'not-configured' };

    const requested = Number(limit);
    const capped = Math.min(
        Math.max(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_LIMIT, 1),
        MAX_LIMIT,
    );

    const keyset = cursor ? decodeCursor(cursor) : null;

    try {
        let query = db
            .from(TABLE)
            .select(COLUMNS)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            // One extra row is the cheapest way to know whether a next page exists.
            .limit(capped + 1);

        if (district) query = query.eq('district', district);
        if (from) query = query.gte('log_date', from);
        if (to) query = query.lte('log_date', to);
        if (keyset) {
            query = query.or(
                `created_at.lt.${keyset.createdAt},and(created_at.eq.${keyset.createdAt},id.lt.${keyset.id})`,
            );
        }

        const { data, error } = await query;
        if (error) return { available: false, entries: [], nextCursor: null, reason: error.message };

        const rows = Array.isArray(data) ? data : [];
        const page = rows.slice(0, capped);
        return {
            available: true,
            entries: page.map(toContract),
            nextCursor: rows.length > capped ? encodeCursor(page[page.length - 1]) : null,
        };
    } catch (err) {
        return {
            available: false,
            entries: [],
            nextCursor: null,
            reason: err && err.message ? err.message : 'unexpected error',
        };
    }
}

/**
 * Report the log's own health for `/api/health` (§17, §18.8). The caller MUST
 * treat this as advisory and must not let it fail the request.
 */
async function health() {
    const configured = isConfigured();
    const db = getClient();
    if (!db) {
        return { reachable: false, configured, lastAppendAt: null, empty: true, stale: false };
    }

    try {
        const { data, error } = await db
            .from(TABLE)
            .select('created_at')
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            return { reachable: false, configured, lastAppendAt: null, empty: true, stale: false, reason: error.message };
        }

        const row = Array.isArray(data) ? data[0] : null;
        const lastAppendAt = row ? row.created_at : null;
        // An empty log is not "stale" — it is a log that has not been written to
        // yet. Only a log that stopped appending is an operational alarm.
        const stale = lastAppendAt ? Date.now() - Date.parse(lastAppendAt) > STALE_AFTER_MS : false;

        return { reachable: true, configured, lastAppendAt, empty: !lastAppendAt, stale };
    } catch (err) {
        return {
            reachable: false,
            configured,
            lastAppendAt: null,
            empty: true,
            stale: false,
            reason: err && err.message ? err.message : 'unexpected error',
        };
    }
}

module.exports = {
    append,
    list,
    health,
    isConfigured,
    // Exported for the mapper tests in §22.1 — the contract translation is the
    // one thing here that can be wrong without a database present.
    _internal: { toContract, toRow, encodeCursor, decodeCursor, DEFAULT_LIMIT, MAX_LIMIT },
};
