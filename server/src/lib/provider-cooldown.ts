// Shared cooldown policy for ordinary routing and Fusion, without importing
// the fallback execution engine into Fusion.
import type { Platform } from '@freellmapi/shared/types.js';
import type { RouteResult } from '../services/router.js';
import { recordOutputRateLimit } from '../services/provider-quota.js';
import { getCooldownDecisionForLimit, getPaymentRequiredCooldownMs, getModelForbiddenCooldownMs, type CooldownDecision } from '../services/ratelimit.js';
import { isRateLimitSignal, isPaymentRequiredError, isAccountSuspendedError, isModelAccessForbiddenError, isDailyQuotaExhaustedError } from './error-classify.js';

// Milliseconds until the next UTC midnight — when most providers' daily free
// allocations reset. Floored at one minute so a hit seconds before midnight
// still records a real bench instead of a no-op.
export function msUntilNextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(next - now, 60_000);
}

const pacificDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric',
});
const pacificHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23',
});

/** Gemini daily quotas reset at midnight Pacific, including DST transitions.
 * https://ai.google.dev/gemini-api/docs/rate-limits */
export function msUntilNextPacificMidnight(now = Date.now()): number {
  const parts = pacificDate.formatToParts(now);
  const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  // 08:00 UTC on the next Pacific date is either midnight (PST) or 01:00
  // (PDT). Read the offset on that date, not now: DST days have 23/25 hours.
  const candidate = Date.UTC(part('year'), part('month') - 1, part('day') + 1, 8);
  const midnight = candidate - Number(pacificHour.format(candidate)) * 3_600_000;
  return Math.max(midnight - now, 60_000);
}

/**
 * The one true cooldown-duration selection after a retryable upstream failure:
 *   - 402 out-of-credits  → a full day (PAYMENT_REQUIRED_COOLDOWN_MS)
 *   - 403 model-not-on-tier → a full day (MODEL_FORBIDDEN_COOLDOWN_MS), because a
 *     tier/subscription gate won't clear on the next minute window (issue #256).
 *     Both honour the operator's cooldown ceiling (#952): relay endpoints emit
 *     these for transient reasons, and a day is then far too long.
 *   - a 429 that says the DAILY free allocation is spent (Cloudflare "used up
 *     your daily free allocation of 10,000 neurons") → benched until the next
 *     UTC midnight, like the 402 path. The old transient 90s cooldown made the
 *     router re-pick a dead-for-the-day provider all day long. An explicit
 *     provider Retry-After wins over the midnight heuristic: rolling daily
 *     windows (Groq RPD "try again in 7m12s" with a Retry-After header) reset
 *     well before midnight, and the provider knows its own reset time best.
 *     Gemini daily violations instead wait until midnight Pacific; a shorter
 *     RetryInfo can refer to a simultaneous per-minute violation.
 *   - anything else → the transient/daily escalation ladder, honoring the
 *     provider's valid Retry-After instead of a transient guess when local daily limits are not exhausted.
 */
export function cooldownForError(route: RouteResult, err: any): number {
  return cooldownDecisionForError(route, err).durationMs;
}

/**
 * cooldownForError plus the provenance tag the cooldown-probe recovery job
 * keys off (see CooldownSource in services/ratelimit.ts): 402 → 'credit' and
 * 403 → 'tier' (a key-validation probe passing proves nothing about credits or
 * tier, so those are never probed); a daily-quota bench → 'authoritative' (the
 * expiry is the provider's own reset time, whether from Retry-After or the
 * UTC-midnight convention — a fact, not a guess); everything else defers to
 * getCooldownDecisionForLimit, which tags 'authoritative' only when an explicit
 * Retry-After actually determined the expiry.
 */
export function cooldownDecisionForError(route: RouteResult, err: any): CooldownDecision {
  recordOutputRateLimit(route.platform as Platform, route.keyId, route.modelId, err);
  if (isPaymentRequiredError(err)) return { durationMs: getPaymentRequiredCooldownMs(), source: 'credit' };
  // Before the model-forbidden check: a suspended account is a 403 too, but
  // it is the KEY that is out, for as long as an empty balance would be — and
  // under the same operator ceiling (#952).
  if (isAccountSuspendedError(err)) return { durationMs: getPaymentRequiredCooldownMs(), source: 'credit' };
  if (isModelAccessForbiddenError(err)) return { durationMs: getModelForbiddenCooldownMs(), source: 'tier' };
  if (isDailyQuotaExhaustedError(err)) {
    const rawRetry = err?.retryAfterMs;
    const retry = typeof rawRetry === 'number' && Number.isFinite(rawRetry) && rawRetry >= 0
      ? Math.min(86_400_000, Math.max(1000, rawRetry)) : undefined;
    if (route.platform === 'google') {
      // RetryInfo can describe a simultaneous per-minute violation. It cannot
      // reopen a daily allowance before the Pacific reset (#1339).
      return { durationMs: Math.max(msUntilNextPacificMidnight(), retry ?? 0), source: 'authoritative' };
    }
    return { durationMs: retry ?? msUntilNextUtcMidnight(), source: 'authoritative' };
  }
  return getCooldownDecisionForLimit(
    route.platform,
    route.modelId,
    route.keyId,
    { rpd: route.rpdLimit, tpd: route.tpdLimit },
    err?.retryAfterMs,
    // Only a real 429/rate-limit error may feed the null-limits exhaustion
    // heuristic; a timeout or 5xx is retryable but says nothing about quota,
    // so it stays on the short transient bench instead of the ladder (#592).
    { quotaSignal: isRateLimitSignal(err) },
  );
}
