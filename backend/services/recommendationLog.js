'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Recommendation-log writer — PRD F15, §11.9, §21.2, §23.1, §20.1.
//
// The cron entrypoint: compute the current recommendation for every district and
// append it, then prune rows past the retention window. NOT an HTTP route — the
// route (§21.2) is only the transport that authenticates and calls this.
//
// The three properties this file exists to hold:
//
//   * Side-effect free reads. No page view can append a row (§9.3), so the log
//     cannot be spammed by traffic and a district's day is not duplicated once
//     per visitor.
//   * Idempotent on the input hash. `canonicalInputHash` is UNIQUE, so re-running
//     the job for unchanged weather inserts nothing and is not an error. The hash
//     is the same F10 digest a user can recompute, which is what makes a logged
//     row independently checkable rather than merely asserted.
//   * Failure is not fatal. An unwritable log never blocks a read or a payout:
//     every store call resolves to a structured result, the job reports honestly,
//     and the next run retries (§16.2, §17).
//
// The log is OUTPUT, never input: nothing here feeds a calculation (§14.5).
// ─────────────────────────────────────────────────────────────────────────────

const { DISTRICT_IDS } = require('../config/districts');
const { computeDistrictWeather, istToday } = require('../engines/deficitEngine');
const recommendations = require('../repositories/recommendations');

/** §23.1. Exposed so the route can report the window it enforced. */
const RETENTION_DAYS = 180;

/** numeric(5,2) in the log table, so a WSI lands on two decimals (§11.9). */
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Build the §11.9 entry from an engine result, or `null` when there is nothing
 * recordable. Pure, so the mapping is testable without a database.
 *
 * Digest notation. §11.9's example writes both hashes as `sha256:<hex>`; §11.4
 * defines `receiptId` as the lowercase hex digest, and §18.2 publishes it bare.
 * The bare digest is stored, because §11.9 requires a row to be "verifiable
 * exactly as a receipt is" — the same bytes must compare equal. The algorithm is
 * not lost: §14.3 fixes it at SHA-256, and the `sha256:` prefix in the example
 * denotes exactly that. `canonicalInputHash` and `receiptId` therefore coincide
 * by construction, because a receipt IS the digest of its own canonical input
 * (§10.2 F10); they stay separate columns because §11.9 defines both.
 *
 * @param {object} result an engine result from computeDistrictWeather
 */
function buildEntry(result) {
  if (!result || result.degraded || !result.engineOutput || !result.receipt) return null;
  const out = result.engineOutput;
  return {
    district: result.district.id,
    date: result.seasonDate,
    season: result.season,
    scenarioId: result.engineInput.scenarioId,
    wsi: round2(out.weightedShortfallIndex),
    payoutTier: out.payoutTier,
    payoutPerHectare: out.payoutPerHectare,
    severityLevel: out.severityLevel,
    aggregateQuality: result.dataQuality,
    durationMode: out.durationIsEstimated ? 'estimated' : 'real',
    canonicalInputHash: result.receipt.receiptId,
    receiptId: result.receipt.receiptId,
  };
}

/**
 * Run the daily job. Districts are computed SEQUENTIALLY: §15.6 requires bounded
 * outbound concurrency, and a cron has no latency budget to defend.
 *
 * @param {{date?:string, deps?:object, now?:Date}} [options]
 *        `deps` is the §22.1 layer-7 seam (mocked externals); production passes none.
 * @returns {Promise<object>} a truthful summary — counts, per-district outcomes,
 *          the retention result and whether the store was usable.
 */
async function runDailyJob(options = {}) {
  const runDate = options.date || istToday(options.now);
  const districts = [];
  const startedAt = Date.now();

  for (const id of DISTRICT_IDS) {
    try {
      const result = await computeDistrictWeather(id, { date: runDate, deps: options.deps });
      const entry = buildEntry(result);
      if (!entry) {
        // Nothing to record is not a failure: the index itself could not be
        // computed, and the log must not invent a row for it (§23.3).
        districts.push({
          district: id,
          stored: false,
          skipped: true,
          reason: result.degradedReason || 'no index computed',
          dataQuality: result.dataQuality,
        });
        continue;
      }
      const appended = await recommendations.append(entry);
      districts.push({
        district: id,
        date: entry.date,
        season: entry.season,
        tier: entry.payoutTier,
        wsi: entry.wsi,
        durationMode: entry.durationMode,
        canonicalInputHash: entry.canonicalInputHash,
        ...appended,
      });
    } catch (err) {
      districts.push({
        district: id,
        stored: false,
        reason: err && err.message ? err.message : 'unexpected error',
      });
    }
  }

  const retention = {
    days: RETENTION_DAYS,
    ...(await recommendations.prune({ retentionDays: RETENTION_DAYS })),
  };

  const logHealth = await recommendations.health();

  const stored = districts.filter((d) => d.stored).length;
  const duplicates = districts.filter((d) => d.duplicate).length;
  const skipped = districts.filter((d) => d.skipped).length;
  const failed = districts.filter((d) => !d.stored && !d.duplicate && !d.skipped).length;

  return {
    status: 'ok',
    runAt: new Date(options.now || Date.now()).toISOString(),
    date: runDate,
    durationMs: Date.now() - startedAt,
    counts: { districts: DISTRICT_IDS.length, stored, duplicates, skipped, failed },
    districts,
    retention,
    log: logHealth,
    // The job succeeded, but the audit trail did not: surfaced so the caller can
    // answer non-2xx and the platform/operator notices (§17 stalled-log alert).
    logConfigured: logHealth.configured,
    logWritable: logHealth.configured && failed < DISTRICT_IDS.length,
  };
}

module.exports = { runDailyJob, buildEntry, RETENTION_DAYS };
