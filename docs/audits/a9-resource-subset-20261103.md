# A9-004 resource subset: November 3 integration receipt

This is a partial resource-safety candidate, not provider or INR invoice certification.
The approved allowance remains INR20 per logical market workflow, shared across
retries/continuations (INR40 for both markets). Resource Option A is separate.

## Active changes

Generic job/run schemas and use cases reject over-limit prompts (1,048,576
characters or 2,097,152 UTF8 bytes), identifiers over the existing 100-character
storage limit, and runs over eight targets. Authorization remains before use-case
validation. ASGI middleware limits actual streamed generic job/run request bodies
to 4,194,304 bytes before parsing, including mounted root paths; Content-Length
is not trusted. No context is truncated or model substituted. Under-limit ordinary
requests remain admitted by these guards.

The main merge's owner-scoped workflow API is explicitly passed to spend
reservation. Owner changes during readiness, authorization or an in-flight reply
cannot cross-account acknowledge or renew an allowance.

## Deliberately unwired components

Pure request preparation preserves stricter token ceilings, rejects hidden retry
contracts and unknown endpoints, validates expanded system/tool-schema input,
and checks tool batches against four/response and 32/job. It must be connected to
atomic durable reservations before dispatch. A POSIX subprocess primitive tests
local deadlines/cancellation and pipe-holding descendants; unsuccessful work is
uncertain and must retain reservations. It is not remote cancellation proof,
crash containment certification, or evidence of no provider charge. No production
adapter, worker, settings or provider registry is activated by these helpers.

The recovered a0ec4958 private resource handoff was verified byte-for-byte:
294700 bytes, SHA256 aee4f32b6c4f320ee6bb7ea5173109efc6741b2f4aa42a9f3be5a8fa2e81da60.
Its worker/fence integration is not blindly applied: the matching execution-claim
module is absent from this branch and its empty certified-adapter registry would
block ordinary analysis. The sole integrator must compose actor-aware SQL queue,
concurrency, first-execution deadline, token/tool and attempt accounting with the
admission/fence lane. Queue waiting must not consume the execution deadline;
retries must never renew its original 600 seconds.

## Offline evidence

- Recovered/adapted actual-use-case validation script: 9 passed.
- New Option A subset: 29 passed, including local timeout/cancellation and descendant cleanup.
- Workflow frontend suites: 113 passed, one skipped, zero failed (114 tests).
- Broader backend regression selection: 351 passed, five skipped, 12 subtests passed.
  An initial failure exposed the arithmetic extraction harness missing main's newly
  imported groupUsIdentityRows helper. The fixture now loads that actual source;
  all five arithmetic tests pass without financial-source or assertion changes.
- TypeScript check produced no diagnostics. No provider/network test was run.

These are local receipts, not current-head CI or production acceptance. PostgreSQL
concurrency/combined migration-DAG qualification remains with the isolated-PG
integrator. No production migration was run.

## Held qualification

No adapter has complete finite transport/reasoning/tool/attempt and actual-INR
settlement evidence. Public tariffs, terminal token usage, request IDs, a planning
FX rate or local connection cancellation do not prove all invoice charges.
Tagged capped workflows therefore retain the existing fail-closed policy. This
must not be described as a working cap that leaves normal workflows available.
Ordinary untagged analysis is not disabled by this resource subset. Unknown
consumption retains reservations and suspends; refunds do not renew gross spend.

Provider-specific dispatch hooks and retry controls require sole-integrator
review; Gemini provider-managed grounding remains owned by the search-privacy
lane and must stay disabled where it bypasses public-query projection. No native
search/tools can be certified merely by token/output bounds. No paid experiments,
credentials, runtime changes, financial actions or worker activation are included.

## Exact integration handoff

No provider/model path can admit a paid call **under this proposed INR cap**:
OpenAI Responses/chat, DeepSeek chat (including Flash), Anthropic messages,
Gemini and Tavily/search remain unqualified. Ordinary untagged analysis follows
its existing uncapped route; its availability is not evidence of cap enforcement.
The five-path offline rejection fixture explicitly locks this distinction.

Shared-file composition belongs to the sole integrator:

| Shared boundary | Required composition, not implemented here |
| --- | --- |
| jobs/tasks.py | Claim/fence ownership; first-execution 600-second deadline; preserve across repair, retry, redelivery; local cancel uncertainty retains spend and resource reservations |
| jobs/use_cases/create_job.py, runs/use_cases/create_run.py | Compose active input guards with actor-aware durable queue/concurrency admission; no new grant on retries |
| api_usage/metering.py | Attribute every actual transport attempt, phase and late outcome; current metered_call passes kwargs through and does not control hidden retries |
| ai_providers/openai.py, deepseek.py, anthropic.py | Apply reviewed zero-retry SDK settings and correct endpoint-specific limits at every initial, rewrite, repair and tool-followup request; use durable atomic token/tool reservations |
| ai_providers/gemini.py | Privacy lane owns adapter changes: preserve disabled unmediated grounding, selected model and full analysis prompt; native streaming completion and absolute deadline remain unqualified |
| ai_providers/tools/web_search.py | Preserve privacy-owned public-query projection; reserve each billed query/fetch and never infer total tool consumption from a final response alone |
| rebalance_budget/runtime.py, ledger.py, policy.py | Keep one original logical allowance and retained uncertain attempts; no resolve_bound activation without finite all-attempt and supported actual-INR settlement proof |

Pure helper contracts are resource_request.bounded_token_request (returns kwargs,
never dispatches/reserves), validate_tool_batch (checks a complete response batch,
never dispatches), remaining_reserved_output (requires complete generated usage,
not charge evidence), and resource_process.invoke_local_json_process (only local
POSIX lifecycle). No worker imports these request/process helpers. Unknown or
late remote charges, parent crashes and remote continued execution remain open.
