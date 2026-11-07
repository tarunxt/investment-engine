# Historical 101-test receipt retained

The following records the isolated 2026-11-02 proposed patch. It is preserved as
history. Current candidate scope and resolved query/metadata boundaries are in
[a9-public-query-release.md](a9-public-query-release.md); the old unresolved-gap
list below is not current acceptance. No original receipt was overwritten.

# A9-005 consumer dispatcher follow-up, 2026-11-02

Reconciled draft PR1393: head `e1405f92f97b95f948ad12106cc2145e72f6acad`,
base/current main `8d25f34a33242adcaab092afdb07af7956f327bd`, unmerged.
The earlier implementation and browser/CI evidence are retained; they were not
reimplemented. This follow-up is an isolated proposed patch for the sole integrator,
not a PR update, integration claim or deployment authorization.

## Supported defects and minimal fixes

1. DeepSeek decoded JSON lists/null/scalars pass through dispatcher rejection, then
   crash on `.get()`. Raw non-string arguments also raise TypeError. Normalize
   non-object/malformed arguments to `{}` for existing fail-closed rejection.
2. OpenAI's argument helper raises TypeError for raw non-string model arguments.
   Catch that type error using its existing empty-object rejection path.
3. DeepSeek sends `tool_choice=none` for `[STAGE2_SHARED_EVIDENCE_ONLY]` but previously
   still executed unsolicited function calls and recovered DSML text into search.
   Both were reproduced through actual `generate()` with scripted model responses.
   Enforce the existing tool-disabled gate in the function-call dispatcher and
   before DSML search recovery. Disabled calls return generic tool errors without
   query metadata; no-tool format repair remains available.

These are deterministic consumer/dispatcher defects. No live model exploit,
universal prompt-injection resistance, or semantic-safety claim is made.

`web_search.py` is unchanged, SHA256
`23be57e2dc4ab7b0184b936edebc5538aa381cecc14124c2c69a22350620886d`.
The adapter's enabled-search path still calls the same `execute()` boundary.
Provider admission, cap and accounting composition must be checked by the sole
integrator against its current shared changes; these fixtures replace model calls
and do not certify a live/global cap. No new egress is enabled.

## Guarded evidence

Run from an environment with backend requirements, pytest and aiosqlite installed:

```
python backend/scripts/verify-search-consumers-offline.py
```

The runner asserts no app module has been imported, installs socket/DNS/audit-hook
guards before third-party imports, clears inherited environment values, and uses
an empty temporary cwd so BaseSettings cannot read a checkout/operator `.env`.
Before application imports it forbids HTTP transports, real OpenAI constructors,
Celery publication and SMTP. Only scripted SDK doubles and fake search functions
are used; no provider constructors, credentials, real model/search requests or
production settings are needed. Guard violations remain fatal even if application
error handlers catch the original exception. Arguments are never logged by guards.

Measured sequence:

- Full malformed-shape baseline: **9 failed, 82 passed, zero guard violations**.
  Failures reproduced the two adapters' argument-handling crashes.
- With argument fixes, disabled-tool baseline: **2 failed, 91 passed, zero guard
  violations**. Both disabled-tool cases reached only the search double.
- With all proposed fixes: **101 passed, zero guard violations**, including existing
  search boundary, analysis-only side-effect, OpenAI and DeepSeek regression suites.
  Dependency deprecation warnings remain; no test is skipped in this guarded run.

`test_search_consumer_dispatch.py` exercises both actual adapter loops, not mocked
`execute()` implementations, for unknown send/export/trade/policy tools, synthetic
sensitive query shapes, malformed raw/JSON arguments, untrusted retrieved content,
and repeated follow-up calls. It checks rejection before `_web_search`, generic
errors without sensitive echoes, unchanged system/user roles, original source URLs,
and absence of authority expansion. Separate real SQLite lifecycle cases submit
hostile model text/policy claims in stage summaries and stored Job/Run output:
notification dispatch remains suppressed; repeated export tasks return before
credentials and append transport. Trade tests here establish dispatcher rejection
of an unauthorized `place_order` tool only; they do not certify a real trading
lifecycle or substitute for its independent broker/owner policy tests.

## Per-ID limits retained

| Deliverable | Added evidence | Still unresolved |
| --- | --- | --- |
| A9-005-A01 | Consumer flow and disabled-tool boundary mapped | Approved public-field schema and privacy decisions |
| A9-005-A02 | Unknown/malformed tools reject at actual consumers; existing disabled-tool gate enforced; error echoes blocked | Valid free-text privacy projection; rejected-query metadata handling; shared cap composition |
| A9-005-A03 | 39 added consumer/lifecycle cases; prior guarded boundary and adapter regression cases retained | Real model behavior, live providers and new production/browser acceptance remain unmeasured |
| A9-005-A04 | Baseline/fix outcomes and zero transport violations recorded; hostile output cannot alter stored analysis-only notification/export policy | Independent review, integrator exact-head CI and policy gates |
| A9-R17 | Existing renderer/output evidence retained unchanged | No new renderer or semantic-validation claim |

Two explicit passing limitation fixtures show that (a) a sensitive string placed
inside the valid free-text `query` reaches only the fake search function, and (b)
a rejected sensitive query can still appear in adapter query metadata and mark
search as used. They document existing gaps, not accepted private egress. No broad
allowlist/redactor or new investment/privacy policy is invented here.

Safe next step: sole integrator applies/reviews the narrow runtime patch plus
fixture/runner patch, preserves current cap/accounting changes, and runs the guarded
command at its exact proposed head. The guarded runner can replace the earlier
unguarded subset in Audit9 CI while retaining the other output/shared-caller tests.
No shared workflow was edited in this follow-up. Keep public-query policy and
metadata semantics as separate explicit decisions; no activation is implied.

No production, host access, credentials, settings changes, paid provider/search,
trade/send/export/refresh/sync, GitHub issue, PR mutation, merge or deployment ran.
