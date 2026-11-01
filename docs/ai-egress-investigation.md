# A9-005 investigation and A9-R17 child evidence

Baseline: fresh `origin/main` at `8d25f34a33242adcaab092afdb07af7956f327bd`,
2026-11-01. The initial checkout `9ae0f20f` was compared against that baseline;
its 15 changed files concern deployment containment and database-viewer ownership,
not this lane's provider, search, contracts or renderer. This remains an
**investigation lead**, not a demonstrated prompt-injection exploit. Synthetic
propagation demonstrates a boundary limitation, not exploitation of a live model.

## Tracked deliverables and acceptance

These are distinct deliverables under one canonical A9-005 root. A9-R17 is a child
checklist, not a duplicate rendering finding. GitHub canonical-issue lookup found
no A9-005 issue; creation was rejected by automatic approval review, so no remote
issue/task creation is claimed. This local ledger preserves IDs pending authorized
canonical tracking.

| Deliverable | Acceptance IDs | Result and remaining gate |
| --- | --- | --- |
| A9-005-A01 | T01, T03 | Trust/data flow mapped below; investigation status retained. |
| A9-005-A01 | T02 | Public/prohibited field proposal documented; **approved schema pending coordinator/privacy decision**. No real values used. |
| A9-005-A02 | T01 | Provider doubles show public query passthrough and extra private field rejection before search; free-text privacy is explicitly unresolved. |
| A9-005-A02 | T02 | Minimal shape/type/name/count/size controls implemented. Arbitrary private text redaction/projection **pending policy and adapter coordination**. |
| A9-005-A02 | T03 | Unknown tools reject, returned retrieval labelled untrusted, exceptions/errors omit argument and provider-body echoes. No model compliance claim. |
| A9-005-A03 | T01 | Synthetic contamination/provider round fixture with socket connections denied. Model response is scripted, not a measured model outcome. |
| A9-005-A03 | T02 | Existing malformed numeric/action/identity/holdings/arithmetic and original-preservation tests pass. No financial contract changed. |
| A9-005-A03 | T03 | Actual renderer in Chromium: inert escaped HTML, no executable raw HTML/events, unsafe link protocol removed, source URL/link isolation/warnings/disagreement retained; rerender/unmount exercised. |
| A9-005-A04 | T01, T02 | Decisions, false-positive risks and untested behavior recorded below. No universal injection resistance or semantic safety assertion. |
| A9-005-A04 | T03 | Existing actual export-worker and repeated email/run fixtures verify independent analysis-only suppression before credentials/dispatch; no side-effect policy changed. |
| A9-R17 | T01 | Actual component/browser test passes with all outbound requests blocked and none observed. |
| A9-R17 | T02 | Existing financial output and Sheets worker tests pass; invalid/ambiguous data remains blocked or preserved according to existing contracts. |
| A9-R17 | T03 | Generic document tests retain `preservation_only` evidence and original bytes; preservation is not semantic validation. |

A9-005 overall is **partial implementation / investigation open**. A9-R17 has local
offline evidence, with independent review and exact-head CI still required.
Deployment, live/provider validation and formal PR approval remain outside this
lane's authority.

## Trust and data flow

1. `OpenAIProvider._generate_with_tools` creates a system message with application
   search guidance/date and a separate user message containing the original prompt.
   Portfolio context in that prompt is data supplied for analysis. It is not a
   grant to publish portfolio/account fields to a search engine.
2. The original prompt goes to the configured model through the existing metered
   adapter. This lane does not change that intended analysis context or the
   format-repair path. Both simple and tool-assisted model calls remain subject to
   the separately owned provider admission/cap work.
3. The model returns tool names/JSON arguments. `_safe_tool_arguments` parses these;
   `web_search.execute` is the shared invocation boundary used by OpenAI, DeepSeek,
   Polymarket event preflight and auto-live evidence. Model tool args are untrusted.
4. Accepted free-text `query` and integer `max_results` reach Tavily, DuckDuckGo or
   Bing through `_web_search`. Fallbacks can send the same accepted query to more
   than one provider. Bing encodes it into a URL. Metering also observes request
   arguments; its storage/privacy behavior is a separate boundary to review.
5. Retrieved answer/title/content/URL/date/score are provider-controlled data.
   Before returning to the model, this change bounds them and adds
   `trust: untrusted_external_data` and a visible truncation flag. Original URLs
   within limits, citations, dates and numeric scores remain intact. Oversized
   provenance is omitted whole rather than silently changing a URL/date.
6. The adapter appends a `tool` role message, preserving system/user separation.
   Query/source metadata is retained by the existing adapter. **Rejected arguments
   can still appear in adapter-authored query metadata** because it records the
   model request independently of dispatch. That follow-up needs the shared-file
   adapter contract; this lane does not claim metadata privacy closure.
7. Output normalization independently validates financial identity/arithmetic and
   allowed labels. Generic documents retain original source and explicitly report
   preservation-only, not semantic certification. `MarkdownRenderer` uses
   react-markdown without raw HTML parsing; its actual browser rendering was tested.
8. Analysis-only side-effect policy is independently resolved from stored owner/run
   state before export credentials or notification dispatch. Model output is not
   policy authority, send/trade authorization or permission for another owner.

## Proposed public-query policy (not yet approved)

Candidate public projection: public ticker/security identifier, public company or
index name, exchange, public event/topic, relevant public date/time window and
currency/unit needed for the user's intended market question. These should be
explicit fields derived from trusted application context and reviewed provenance,
not a model's assertion that arbitrary text is public.

Prohibited search fields: owner/account/run identifiers, names/contact details,
credentials/session material, holdings/units/position value/cost basis, private
notes/documents and raw prompt/retrieved instructions. Do not silently delete
financial meaning to force a query through. Preserve the original analysis prompt;
when public projection is unavailable, report that boundary rather than fabricate
an answer. The model-provider analysis payload and search-engine query have
separate purposes and need separately approved policies.

Current runtime compatibility retains `query` plus `max_results`, rejecting extra
fields. This is an argument-shape allowlist, **not proof that query text is public**.
The synthetic-private-value query fixture deliberately shows accepted free text
still reaches a mocked search provider. No live egress was performed.

Coordinator decisions required: approve public-field semantics and ambiguous-input
handling, decide false-positive policy, and agree adapter integration with the cap
worker/A10/A9-004. No provider adapter, output contract, renderer, auth code or
financial-worker configuration was edited here.

## Observed decisions and limits

- Allowed unchanged: NIFTY live context, company earnings, INR/₹ and explicit
  warning/disagreement search wording. This preserves intended search meaning.
- Denied before search: unknown tools, additional `portfolio`/`account_id` fields,
  non-string/empty/oversized/control-character queries, string/bool/out-of-range
  counts. A generic error omits rejected tool name/argument values.
- Provider failures omit exception bodies. Malformed/oversized provider payloads
  return generic errors. Error payloads omit the query echo. Partial result data is
  still external, untrusted material.
- Results: at most requested count (1–8), title 512 chars, content 4096 chars per
  result, answer 4096 chars, URL 2048 chars and date 128 chars. Input provider JSON
  above 1,000,000 characters rejects. Truncation is explicit; provider raw response
  size before JSON construction and SDK/HTTP streaming memory are not bounded here.
- Potential false positives: previously coerced numeric strings/bools now reject;
  legitimate multiline or >512-character queries reject. No silent query rewrite.
  Long source content loses its tail visibly; long URL/date is omitted, so downstream
  evidence sufficiency must not assume complete coverage. Substantive privacy
  filtering and final threshold approval remain independent review gates.
- Untested: real model instruction following, encoded/private text classification,
  prompt injection success rates, all live providers, production rendering shell,
  paid/model latency, telemetry retention and model-based semantic evaluation.
  A trust label does not force a model to obey policy. Deterministic fixtures cannot
  establish universal injection resistance, financial correctness or safe action.

## Reproducible local evidence

```
PYTHONPATH=backend /tmp/a9-venv/bin/python -m pytest -q \
  backend/tests/test_search_egress_boundary.py \
  backend/tests/test_web_search_tool.py \
  backend/tests/test_openai_provider.py \
  backend/tests/test_output_contracts.py \
  backend/tests/test_rebalance_side_effect_policy.py \
  backend/tests/test_google_sheets_output_contracts.py
# 166 passed; existing dependency/deprecation warnings only.

cd frontend
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  node --test tests/markdown-renderer-offline.test.mjs
# 1 passed; actual renderer mount/rerender/unmount; zero outbound requests.
```

New search fixtures forbid socket connections; the provider-round double replaces
both the SDK client and metered invocation. Browser transport aborts all requests.
Existing output, Sheets and side-effect suites use local synthetic fixtures/fakes.
No real provider/search, refresh/sync, credentials, account data, sends, trades,
exports, production probes, host access, worker restart, merge or deployment ran.

Additional unchanged shared-caller regression suites: `test_deepseek_provider.py`,
`test_polymarket_event_preflight.py`, `test_polymarket_auto_live_evidence.py`: **13 passed**.

Dedicated PR workflow `.github/workflows/audit9-egress-offline.yml` reruns these
checks with synthetic environment values and a locally installed browser. Local
success does not claim exact-head hosted CI or independent review completion.
