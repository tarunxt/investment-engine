# API attempt metering

The additive `api_usage_attempt_events` ledger measures the upstream invocations
visible to the existing provider adapters. It does not change provider selection,
model counts, independent samples, prompts, search policy, SDK retry settings,
trading decisions, or existing API response/accounting shapes.

## Immutable events and identity

Every invocation appends a `started` event before the upstream call and a separate
`finished` event on success, failure, or cancellation. `attempt_id` links the two;
`event_id` identifies each immutable event. A unique `(attempt_id, event_kind)`
constraint makes event replay idempotent. A process killed without cleanup leaves
an unmatched start with unknown usage and cost, rather than a fabricated zero.
The recorder never updates existing events.

Authenticated job ownership, execution/task ID, job retry number, run, workflow,
market, stage and independent sample are attached when available from worker
context. Unknown identity remains null. A continuation points to its preceding
observable attempt. Explicit Gemini key retries and observable Celery retries
have a `retry_of_attempt_id` when the preceding attempt can be established. The
Celery link requires the same job, task execution ID and sample; missing history
is not invented. `provider_usage_phase()` labels job-level repairs without
changing the provider interface.

Provider request IDs and response IDs are separate. Provider-returned model IDs
are recorded separately from the requested model; omission leaves actual model
unknown. Dedupe enforces independent unique provider/response-ID and
provider/request-ID hashes in separate namespaces. A request-only delivery and a
later delivery with the same request ID plus a response ID remain one estimated
charge. Credentials are server-wide, so this response scope
is shared across app users; replay does not create a second charge merely by
changing user context. No credential is read or hashed for this identity. A different attempt delivering the same identified response
keeps its own events and reported usage, links `duplicate_of_attempt_id`, and has
no second tariff charge. A new identity alias learned on that duplicate event is
retained so a later partial-ID delivery also resolves to the original charge.
Identical model/prompt/sample settings are never dedupe
keys. Missing provider IDs still produce complete attempt/event identity and do
not suppress usage; without an upstream ID, two distinct invocations cannot be
asserted to be duplicate responses.

## Coverage and limits

Instrumented boundaries are OpenAI Responses/chat completions, Anthropic
messages, all DeepSeek tool/recovery/format calls, Gemini streaming calls and
explicit key rotation, Tavily search, DuckDuckGo search, and Bing RSS HTTP calls.
Existing job repair calls inherit row/format phases. Stream usage snapshots are
cumulative: the latest provider-reported snapshot is kept, not summed per chunk.
A later snapshot that omits a counter retains its last observed non-null value.
A stream interrupted after reporting usage retains the observed partial usage.

Search attempts record only aggregate `search_result_count`: the returned result
list length for Tavily/DuckDuckGo, or the parsed, bounded output count for Bing.
An observed empty result list is zero; a failed or unobserved result is null.
`reuse_status` is `not_reused` at these actual upstream-invocation boundaries.
This describes application result reuse, separately from provider token caching
or duplicate response delivery. It does not imply the provider charged for the
call. No new cache/reuse behavior is introduced.

The default scope is `sdk_call_hidden_retries_unknown`: a library invocation may
contain internal wire retries that the SDK does not expose. DuckDuckGo can also
perform multiple internal fetches. Bing is labelled
`http_call_redirects_unmeasured`. These are honest instrumentation limits, not
exact counts of every HTTP exchange. No SDK retry/timeout setting was changed.

Persistence fails open and logs an attempt identifier if unavailable. This avoids
turning telemetry failures into provider failures but means an unavailable DB can
leave a gap; absence of events does not prove no charge occurred. No invoice
reconciliation or forced allocation of daily residuals is implemented.

## Usage, privacy and cost interpretation

`reported_usage` is an allowlist of provider-returned numeric token, cache,
reasoning and tool/search counters. Missing values remain null. Cache values
inferred for a tariff estimate appear only in `inferred_usage`. The DeepSeek
legacy cache fallback is not relabelled as provider-reported usage.

`prompt_hash` is a SHA-256 digest of canonical request arguments (or the explicit
hash input for streaming/search). Evidence and schema digests are attached only
when separately identifiable in worker context. The new ledger stores no raw
prompts, keys, search queries, response bodies or exception messages. Existing raw
DeepSeek request/response and search query/error logging is removed from the
instrumented paths.

`tariff_estimated_cost_usd`, `provider_billed_cost_usd`, and `allocated_cost_usd`
are distinct. This patch writes only the tariff estimate, using known rates in
the existing repository snapshot `repository-c37e6ce7-v1`. The historic tables
contain no tariff effective date, so `tariff_effective_date` is null. These rates
were not verified against live providers. Unknown tariffs or missing required
usage produce a null estimate. A provider reporting zero tokens can legitimately
produce a zero estimate.

`tool_tariff_estimated_cost_usd` and `tool_provider_billed_cost_usd` explicitly
remain null: the adapters do not provide verified tool fee amounts, and no tool
tariffs are supplied. Provider-reported search/tool units are kept independently
in the usage allowlist (for example Tavily credits and Anthropic server-tool
request counts). A unit or result count is never converted into a guessed USD fee.

A listed input/output tariff estimate is token-only and excludes unpriced cache,
reasoning and tool fees;
its assumptions are recorded in `inferred_usage`. DeepSeek estimates use reported
cache counts where available and label any inferred cache split explicitly.
Neither estimate is a provider bill. The existing legacy DeepSeek ledger and
its `actual_cost` compatibility field remain unchanged; that historic field
contains tariff-derived estimates, not newly verified billing. Do not combine
legacy cost rows with the new attempt ledger to sum the same calls twice.

When aggregating, select `event_kind == 'finished'` and exclude duplicate
responses. Sum known estimates and separately report unknown-cost attempts and
unmatched starts; do not coalesce unknown values to zero or call a partial sum a
complete bill. Distinct samples and all repair/recovery/retry calls remain in the
count and cost total.

## Validation and rollout boundary

`test_api_usage_attempts.py` uses in-memory SQLite and mocked SDK/search calls,
with sockets blocked. It covers immutable lifecycle events, idempotent delivery,
missing IDs/usage, independent samples, retry linkage, recovery/repair cumulative
accounting, partial streams, cancellation/errors, privacy and search fallbacks.
Concurrent independent SQLite transactions verify one estimated charge when
distinct attempts and event replays race on the same provider IDs. Tests also
cover aggregate search counts, incomplete snapshots, and malformed error metadata.
Existing provider/accounting tests keep network/database telemetry disabled.

The authored migration `api_attempt_events_001` follows `universal_scan_001` and
adds only the new table, indexes and uniqueness constraints. The model is imported
in both canonical metadata registries. AST inspection verifies model/column
parity and the complete revision graph (including annotated assignments and merge
revisions) has one head, `api_attempt_events_001`.
Alembic execution is permitted only in the
repository's Docker backend container. Docker is unavailable in this work
session; no migration was executed, and production/database deployment remains
outside the approved offline scope.

Deduplication requires a shared provider identifier. If two deliveries initially
have disjoint identifiers and a later delivery reveals that they are related,
the append-only rows retain those identifiers for reconciliation; a raw sum is
not a proven invoice total. Missing identifiers, hidden SDK retries, persistence
failures, and unattributed provider-day billing remain explicit limitations.
