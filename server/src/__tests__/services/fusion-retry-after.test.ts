import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getCooldownDecisionForLimit, recordRequest, parseProviderLimit, learnLimitFromError } from '../../services/ratelimit.js';
import { providerHttpError, parseRetryAfterMs } from '../../providers/base.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import { parseOutputRateLimit } from '../../lib/output-rate-limit.js';
import { getKeyQuotaHeadroom, recordQuotaObservation } from '../../services/provider-quota.js';
import type { RouteResult } from '../../services/router.js';

const limits = { rpd: 250, tpd: null };
const otpMessage = 'Rate limit reached on output tokens per minute (OTPM): Limit 1000, Used 999, Requested 48. Please try again in 2.8s.';
const route = { platform: 'groq', modelId: 'qwen/qwen3.8-27b', keyId: 1, modelDbId: 1, rpdLimit: 250, tpdLimit: null } as RouteResult;
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => vi.useRealTimers());

describe('authoritative 429 retry delay', () => {
  it('uses the 3s header over prose and the 90s heuristic', () => {
    const err = providerHttpError(new Response('', { status: 429, headers: { 'Retry-After': '3' } }), otpMessage, { error: { message: otpMessage } });
    expect(err.retryAfterMs).toBe(3000);
    expect(cooldownDecisionForError(route, err)).toEqual({ durationMs: 3000, source: 'authoritative' });
  });
  it('honors a future HTTP-date with deterministic time', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-17T19:00:00Z');
    const retry = parseRetryAfterMs('Sat, 17 Oct 2026 19:00:03 GMT');
    expect(retry).toBe(3000);
    expect(getCooldownDecisionForLimit('groq', 'm', 1, limits, retry)).toMatchObject({ durationMs: 3000, source: 'authoritative' });
  });
  it.each([-1, NaN, Infinity])('rejects invalid numeric delay %s', value => {
    expect(getCooldownDecisionForLimit('groq', 'm', 1, limits, value)).toEqual({ durationMs: 90000, source: 'heuristic' });
  });
  it.each(['-1', '1.5', 'NaN', 'Infinity', 'tomorrow'])('does not parse malformed HTTP header %s as a date', value => expect(parseRetryAfterMs(value)).toBeUndefined());
  it('keeps a bounded minimum for zero and caps huge positive delays', () => {
    expect(getCooldownDecisionForLimit('groq', 'm', 1, limits, 0).durationMs).toBe(1000);
    expect(getCooldownDecisionForLimit('groq', 'm', 1, limits, 1e20).durationMs).toBe(86400000);
  });
  it('retains the fallback when absent, on 5xx, and for proven daily exhaustion', () => {
    expect(getCooldownDecisionForLimit('groq', 'm', 1, limits).durationMs).toBe(90000);
    expect(getCooldownDecisionForLimit('groq', 'm', 1, limits, 3000, { quotaSignal: false }).durationMs).toBe(90000);
    recordRequest('groq', 'm', 1);
    expect(getCooldownDecisionForLimit('groq', 'm', 1, { rpd: 1, tpd: null }, 3000).durationMs).toBeGreaterThanOrEqual(90000);
  });
  it('keeps backoff working without an error or observation storage', () => {
    expect(cooldownDecisionForError(route, undefined).durationMs).toBe(90000);
    getDb().exec('DROP TABLE provider_quota_observations');
    const err = providerHttpError(new Response('', { status: 429, headers: { 'Retry-After': '3' } }), otpMessage);
    expect(cooldownDecisionForError(route, err)).toEqual({ durationMs: 3000, source: 'authoritative' });
  });
});

describe('OTPM is separate evidence, never total TPM', () => {
  it('parses only explicit provider output counters', () => {
    expect(parseOutputRateLimit(otpMessage)).toEqual({ limit: 1000, used: 999, requested: 48 });
    expect(parseOutputRateLimit('tokens per minute (TPM): Limit 1000, Used 999, Requested 48')).toBeNull();
    expect(parseOutputRateLimit('OTPM: Limit 1000')).toBeNull();
    expect(parseOutputRateLimit('OTPM: Limit 99999999999999999999, Used 1, Requested 1')).toBeNull();
  });
  it.each(['output tokens per minute (OTPM)', 'input tokens per minute (ITPM)', 'output tokens per day (OTPD)'])('does not learn %s into a total-token column', axis => {
    expect(parseProviderLimit(`${axis}: Limit 1000, Used 999, Requested 48`)).toBeNull();
    const model = getDb().prepare("SELECT id, tpm_limit FROM models WHERE platform='groq' LIMIT 1").get() as { id: number; tpm_limit: number };
    expect(learnLimitFromError(model.id, { message: `${axis}: Limit 1000, Used 999, Requested 48` })).toBeNull();
    expect(getDb().prepare('SELECT tpm_limit FROM models WHERE id=?').get(model.id)).toEqual({ tpm_limit: model.tpm_limit });
  });
  it('persists model/key-scoped output evidence without changing account quota scoring', () => {
    recordQuotaObservation({ platform: 'groq', keyId: 1, metric: 'tokens', limit: 8000, remaining: 4000, confidence: 1 });
    const err = providerHttpError(new Response('', { status: 429, headers: { 'Retry-After': '3' } }), otpMessage);
    cooldownDecisionForError(route, err);
    const evidence = getDb().prepare("SELECT key_id,model_id,metric,limit_value,remaining_value,retry_after_ms,reset_at,raw_json FROM provider_quota_observations WHERE metric='output_tokens'").get();
    expect(evidence).toEqual({ key_id: 1, model_id: route.modelId, metric: 'output_tokens', limit_value: 1000, remaining_value: 1, retry_after_ms: 3000, reset_at: null, raw_json: null });
    expect(getKeyQuotaHeadroom('groq').get(1)).toBe(0.5);
  });
});
