# A9-005 public-query candidate, 2026-11-03

PR1393 is the existing review vehicle. Current main `ece97f64` was merged before
implementation; its newer logging/redaction, verifier, display and UI fixes are
retained. No old CI result is current integration acceptance. Prior baseline and
101-test receipts remain historical, including their original failures and gaps.

## Concrete safe default and product tradeoff

Outbound search text is now generated solely from application-owned constants:
`market` is `india`, `us` or `global`; `topic` is `prices`, `news`, `earnings` or
`macro`. The public subjects are NIFTY 50, S&P 500 and global markets. Fixed topic
phrases generate twelve public queries. No free-form company name, ticker, owner,
account, holding, units, cost basis, document, credential or private note is copied
from a prompt, model assertion, retrieved source or portfolio snapshot. This fixed
catalog is trusted application context; private holdings are deliberately NOT a
public-security registry. The model can choose an allowed public topic but cannot
supply outbound words. Exact canonical legacy query strings remain compatible;
all other free text, extra fields and mixed structured/free-text input reject.
The original analysis prompt, financial values, units and dates are unchanged.

Recommended release default: keep this closed catalog and fail ambiguous/custom
queries without rewriting them. Company-specific and custom/event search is
unavailable and returns an explicit missing-current-evidence error. The alternative
requires an independently approved public security/event catalog with trusted
provenance plus product/privacy scope review; do not infer it from a user's holdings
or relax the boundary to regex-cleaned arbitrary text. This candidate does not
activate such a catalog or new provider path. Public market/topic selection and
query ordering/count remain model choices; covert-channel/model-compliance
properties are unmeasured, not universal injection resistance.

## Enforcement and preservation

- `execute()` projects closed fields before any search/settings/transport access;
  `_web_search()` independently rejects noncanonical text and invalid counts before
  Tavily/DDG/Bing dispatch. Existing metered-call signatures/placement, provider
  fallback order and result bounds are retained. No spend cap is overridden.
- OpenAI/DeepSeek and the two Polymarket evidence consumers record queries only
  from admitted tool output, never rejected model/constructed strings. Rejected
  attempts do not claim search usage or carry private-query metadata. DSML recovery
  follows the same rule. This does not rewrite historical saved metadata.
- Gemini native Google Search grounding is disabled because its provider-managed
  queries cannot pass through the local projection. Original analysis and observed
  token accounting stay intact; unsolicited query/source metadata is not stored or
  treated as admitted evidence. No alternate native search is enabled. Provider capability metadata now reports native search unavailable rather than advertising attached grounding.
- Malformed/raw/non-object tool args reject without a consumer crash. DeepSeek's
  existing evidence-only marker blocks unsolicited calls AND DSML search recovery;
  no-tool formatting recovery remains. Unknown send/export/trade/policy tools deny.
- Admitted retrieval stays explicitly untrusted and bounded. Source URLs, dates,
  numeric scores, warnings/disagreement and original content within bounds remain.
  HTML renderer and financial output contracts are unchanged.
- Analysis-only notification/export gates still run before dispatch/credentials.
  No model content authorizes trades, sends, policy changes or another owner.

## Current offline evidence and per-ID scope

Run `python backend/scripts/verify-search-consumers-offline.py` with repository
backend dependencies, pytest and aiosqlite installed. The runner installs network,
SDK, HTTP, Celery and SMTP guards before app imports; clears inherited environment;
uses an empty temporary cwd instead of reading operator .env; only scripted SDK and
search doubles are permitted. Guard violations are fatal even if caught by app code.

Local current candidate: **320 passed, zero guard violations**, including all twelve
public projections, private/ambiguous field denial before invocation, actual
OpenAI/DeepSeek loops, sensitive-query metadata denial, malformed args, tool-disabled
recovery, hostile-content SQLite notification/export lifecycle fixtures, shared
consumer tests, financial output invariants and Sheets task regressions. One legacy
DSML fixture initially failed because it expected custom raw query metadata; its
synthetic query now uses the approved catalog while recovery/token/cost assertions
remain. No acceptance test was dropped. Actual Chromium renderer mount/rerender/
unmount: **1 passed**, zero outbound requests; source URL/link isolation, warnings,
disagreement and escaped hostile markup retained.

| ID | Current source/test result | Remaining limits |
| --- | --- | --- |
| A9-005-A01 | Trust map retained; explicit closed public-field projection and prohibited fields implemented | Broader company/event catalog requires independent provenance and scope decision |
| A9-005-A02 | Arbitrary private query text blocks; rejected-query metadata suppressed in four consumers; strict tool/count/shape/result boundaries | Full cap-lane composition and independent review required; no live provider certification |
| A9-005-A03 | Guarded consumer/lifecycle/output checks and actual renderer pass | Scripted responses do not measure model obedience, semantic correctness or live attack success rates |
| A9-005-A04 | Baseline failures, false-positive tradeoff and current tests recorded; independent effect gates preserved | Integration CI/review and serialized root-owned deployment are separate from local evidence |
| A9-R17 | Existing actual renderer and financial/generic-preservation invariants retained | Preserved documents are not semantically validated or safe to act on |

A9-005 remains an investigation lead; the reproduced malformed-argument and disabled
tool consumer defects are narrow supported defects, not a demonstrated live prompt
injection exploit. Existing private-analysis data sent to the configured model,
existing retention/telemetry history, redirects/transport allowlists, provider-side
billing and model-output factual truth are separate boundaries. No real provider,
search, credential, account, send/export/trade, host, production/settings change,
financial-worker activation or deployment was performed by this lane.

## Integration contract

Root/sole integrator must review the exact shared-file diff against cap PR1396.
The changes add projection/metadata checks around existing `execute()` calls and
leave metered transport signatures and accounting placement unchanged. No cap
branch payload is imported, no certified-provider gate is removed, and no financial
worker is started. Keep all independent admission/owner/side-effect gates when
resolving overlaps. Merge/deploy are root/sole-production-operator actions only.

CI correction history: at head25fd3370, Audit9 offline workflow41686749693 and
API migration41686749692 passed. PR run41686749691 exposed one inherited metering
fixture that attempted the now-denied literal `private search` (1381 passed, one
failed, one skipped,22 subtests). The positive fallback fixture now uses a canonical
public query without dropping ledger assertions; a new negative fixture verifies
private denial produces zero transport calls and zero attempt rows. All accounting
cases now join the pre-import guarded local runner:320 passed, zero violations.
The original failed run is retained; new exact-head CI is required.
