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
changing user context. No credential is read or hashed for this identity. A different priced attempt delivering the same claimed response
keeps its own events and reported usage, links `duplicate_of_attempt_id`, and has
no second tariff charge. Unpriced finished events retain raw provider IDs but
leave charge-identity keys unclaimed, so omitted/partial usage cannot suppress a
later observed estimate. Their IDs remain available for reconciliation; they are
not evidence of an additional charge. A new identity alias learned on a priced duplicate event is
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

## Bounded coverage summaries

New start/finish events record a versioned `coverage` explanation inside the
existing `inferred_usage` JSON, separately from provider-returned numeric facts.
`usage_status` distinguishes `unavailable` (no observable response/usage),
`omitted` (observed response without usable allowlisted counters), `malformed`
(unusable usage metadata), and `reported` (at least one valid numeric counter).
Fixed allowlisted field names identify malformed counters even when other valid
usage is retained. Explicit zero is valid; booleans, negative/nonfinite numbers,
numeric strings, and fractional token counts are rejected rather than coerced.
Partial usage remains partial: no missing input/output/cache counter is filled
into provider-reported evidence.
Disagreeing valid aliases/containers or decreasing cumulative counters set the
affected reported field to null and retain fixed `conflicting_fields` diagnostics
for the attempt. Later larger snapshots do not erase that ambiguity. Malformed
or conflicting required cache counts do not trigger an inferred cache price.

Usage extraction runs independently of optional response identity/choice metadata.
Errors retain any observed stream usage and available allowlisted usage on the
exception, its response, or already-decoded SDK `body`/`details` mappings, while
the lifecycle status remains error/cancelled. This does not call `response.json()`,
read raw response bodies, or request extra upstream data. If the SDK discarded
usage, it remains unavailable. Numeric snapshots are cumulative, not summed.

`cost_status` distinguishes a partial listed-token estimate, reported but
unpriced usage, and unavailable estimates; `cost_reason` identifies missing
usage, required token counts, tariff, or invalid tariff/cache data. Tool fees and
provider bills stay null. An estimate is never represented as complete billing.
No historical rows, existing prices, accounting endpoints, or schemas change.

Tavily now passes only the metadata flag `include_usage=True` in the existing
search call. The [official Search API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
and pinned `tavily-python==0.7.24` SDK define this as returned credit-usage metadata.
The query, advanced depth, result count, answer flag, fallback order, and retries
are unchanged. Observed credits, including zero, are preserved; no dollar tariff
is invented. DDG/Bing result counts are not billable usage counters.

`api_usage.coverage.summarize_attempt_coverage(events, max_event_rows=10_000)`
is a pure helper for an already selected, authorized event window. It performs no
database queries and exposes no endpoint. The hard cap is 10,000 event rows; it
reads at most one additional item to flag truncation. Invalid rows and repeated
`(attempt_id, event_kind)` events are counted separately. Identical bounded
accounting/coverage projections count as replays. Contradictory projections count
as `conflicting_event_rows`, mark the attempt ambiguous, and quarantine all of
its token and tool estimates. Conflicting group labels become `unknown`, and
unsupported provider, phase, and status strings are always mapped to `unknown`.
A finish takes precedence over its start regardless of input order; conflicting
representations of a start still quarantine that attempt's finished estimate.

The report groups attempts by actual provider, phase, and status, with separate
usage status, evidence source, malformed-field, cost status, and reason counts.
Missing or unsupported coverage metadata remains `legacy_unknown`; the report
does not infer whether historical usage was omitted or unavailable. Numeric cost
and usage observations remain independent of that provenance classification.
`known_reported_usage_attempts` counts an attempt with at least one valid numeric
allowlisted usage value, including zero; `missing_reported_usage_attempts` counts
the rest, even when metadata claims usage was reported. These counts include
duplicates and unmatched starts, whose lifecycle counts remain separate. For a
conflicting event, numeric availability means that some supplied representation
contains usage, with an `ambiguous` usage classification; no quantity is trusted.
Only finite, nonnegative estimates on finished, nonduplicate, unambiguous attempts contribute to known
token and tool subtotals. An explicit zero is counted as known; no known estimate
produces a null subtotal. Search attempts lacking tool estimates remain visible.

Unmatched starts and finishes without a start refer only to the supplied window;
truncation can split a lifecycle pair. These counts do not prove process death or
lost events. The report never revises historical rows, fills billing gaps, or
combines legacy ledger totals. `invoice_total_usd` remains null, and hidden SDK
retries, persistence gaps, and unpriced native tools remain stated limitations.

A persisted `conflicting_provider_identity` flag propagates through the supplied
`duplicate_of_attempt_id` links and shared raw provider request/response IDs,
quarantining canonical estimates and other linked attempts in the window. Raw
IDs are matched only within a recognized provider, with separate request and
response namespaces. A later response containing both IDs can therefore connect
previously disjoint request-only and response-only estimates. These links only
propagate a recorded ambiguity flag; they do not establish invoice deduplication
or suppress unflagged estimates. Linked identities outside the window are counted
explicitly, without fetching or assigning costs to them. Missing IDs and unknown
provider scope cannot establish such a bridge. All identifiers stay internal to
lifecycle matching and conflict propagation.
The recorder adds that flag only to the new duplicate event when overlapping
known usage or known tariff estimates disagree with the canonical priced event,
or when its request/response IDs bridge multiple distinct canonical roots.
The earlier event remains immutable, including an earlier explicit zero. Reports
must use the conflict-aware helper over the relevant window instead of treating
a raw sum of canonical estimates as settled cost.
