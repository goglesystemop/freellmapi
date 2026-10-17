# Fusion rate-limit handling: Retry-After and output-token quotas

This change follows the canonical-provider resolution fix. Full IDs still pin a literal model; canonical IDs can choose a configured provider. No provider keys or user settings are part of this patch.

## Retry decisions

For an actual rate-limit signal with a finite nonnegative upstream delay, the delay replaces the generic 90-second guess. A one-second minimum prevents a zero/past-date hint from forming a busy loop; the existing one-day maximum bounds malformed extreme values. HTTP delta-seconds and HTTP-date headers take precedence over body retry prose. Invalid hints retain the fallback.

This does not remove independent local request/token gates. Proven daily exhaustion still has conservative protection. Explicit daily quota, credit, access-tier and local-endpoint handling retain their dedicated policies, including Google's daily reset protection. A Fusion attempt never sleeps and spins on the same credential: it marks that model/key attempted, then reports the provider error or a routing reason. A later client request may try after the cooldown expires, subject to all quota gates.

## Output tokens are a distinct axis

Groq's observed error names OTPM (output tokens per minute), whereas `rate_limit_usage` tokens are total input + output tokens. Neither the total TPM counter nor a general `x-ratelimit-limit-tokens` header proves the available OTPM balance. Completion usage can differ from provider-metered output (for example, hidden reasoning), so a fabricated local rolling-window OTPM ledger could give false permission to dispatch.

The implementation therefore:

- Parses explicit OTPM `Limit / Used / Requested` counters only, without retaining the upstream body or organization identifiers.
- Stores provider evidence in the existing quota observation/state tables as `output_tokens`, scoped by platform, model and actual key ID. No schema migration or hard-coded 1000-token catalog limit is needed.
- Keeps the output snapshot separate from total-token quota pools, account-wide key selection weights and daily balance badges.
- Records Retry-After as a retry hint, without inventing a full-window reset time. The provider cooldown enforces the wait.
- Prevents input/output-only limits from being learned into total TPM/TPD columns. It does not automatically edit an already learned operator/catalog value.

This is separate observation and correct reactive waiting, not a claim that the service knows an exact predictive OTPM balance. A proactive output gate would need provider-defined window semantics, reliable output/reasoning accounting and per-attempt output reservations; it must not infer these from total tokens or mark all models on an account exhausted because one model hit OTPM.

## Diagnostics

Pinned Fusion routing carries the same key-selection diagnostics used by the normal router. A failed slot can report a missing/disabled/unhealthy key, model-specific cooldown with retry seconds, request rate limit, total token rate limit, or daily quota exhaustion. Explicit judge failures are also retained as `x_fusion.judge_error` when panel details are exposed. No key material or key labels are included in these messages.

## Regression coverage

Tests cover 3-second header precedence over retry prose; future dates; malformed/negative/nonfinite hints; minimum and maximum bounds; absent hints and non-quota errors; independent daily exhaustion; output-axis parsing and persistence; total-TPM protection; account-wide scoring/badge isolation; real Fusion HTTP calls that do not dispatch during cooldown and can try after its expiry; missing keys and RPM/RPD/TPM/TPD diagnostics; and the existing canonical-provider resolution cases.
