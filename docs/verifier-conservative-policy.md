# Conservative captured-claim verifier

A10-005-R01 and A10-005-R02 characterize `reversal-evidence-v1` at source
`8d25f34a33242adcaab092afdb07af7956f327bd`. This is an investigation of captured
claims and data checks, not a strategy benchmark, proof of profitable trading,
or a failed-strategy classification. Performance remains not established.

## Current decision table

For a captured trigger and invalidation, both critical, with no other claims:

| Trigger condition | Invalidation met | Invalidation not met | Invalidation unknown |
| --- | --- | --- | --- |
| True | unsupported | insufficient_evidence | insufficient_evidence |
| False | unsupported | unsupported | unsupported |
| Unknown | unsupported | insufficient_evidence | insufficient_evidence |

A met invalidation contradicts. An unmet invalidation is neutral, leaving its
claim unknown. It does not support the exit or certify a negative assertion.
A false trigger contradicts; absent/ineligible evidence leaves it unknown.
Any critical contradiction takes precedence over all support and data findings.
Otherwise support requires at least one critical claim, support for **every**
critical claim, and no data findings. A trigger-only supported claim can therefore
produce supported, whereas the paired trigger/invalidation example cannot do so
through candle observations. This is the preserved conservative policy.

## Exact capture and eligibility

`claims_for` reads trigger/invalidation text (up to 2000 characters) from frozen
technical evidence. Exactly one recognized `close above/below` numeric condition
becomes a close claim; other nonempty text becomes qualitative. Bare breakdown or
rejection levels do not become completed-close assertions. Non-score rationale
fields from the first 20 samples are combined into qualitative claims. All these
claims default to critical. Repetition cannot certify qualitative rationale;
eligible contradiction can still contradict it.

`evaluate` accepts an observation only for the matching claim, with independent
true, a known original completion deadline, and known availability no later than
that deadline. Supporting observations additionally require countersearch complete.
Contradictions do not require countersearch complete. Observation publication and
observation times are not separately checked by this evaluator: adapters must
establish their provenance. This characterization does not add a new gate.

The candle adapter requires complete exactly true, known completion no later than
`decision_at`, and availability no later than that time when availability is
present. Missing availability can yield a retrospective observation but cannot
pass evaluator eligibility. Claim start/end bounds are inclusive on completion.
The latest eligible completion is selected, not an earlier crossing. A missing or
nonpositive close yields no observation. Comparisons are strict: equality fails a
trigger and leaves invalidation neutral. `decision_at` selection and original
completion eligibility are distinct deadlines. Future/incomplete candles are
excluded. No current quote proves a completed daily close.

Independent findings withhold support for unknown original completion, absent or
unverified comparison identity, calculation errors, or unequal attempted/successful
coverage. Existing source uses equality for coverage, so two absent counts compare
equal; this work documents that limitation rather than changing it. Worker source
limitations downgrade supported to insufficient, and cannot override unsupported.
Failed immutable capture/ownership produces worker failure, not certification.
Stored-only checks have no external observations; unavailable sources cannot certify.

## Explanations and history

New claim `explanation` metadata contains version `claim-explanation-v1`, code and
readable reason. It distinguishes neutral unmet invalidation and qualitative
non-certification from missing eligible evidence, incomplete countersearch and
unresolved evidence. Existing states, verdict, findings, observation bytes, scope,
and policy version are preserved. Explanations do not participate in decisions.
Old stored results are not rewritten; absent explanation must remain acceptable.
Worker limitation messages and data findings remain authoritative.

## Evidence and limits

`backend/tests/test_verifier_explanations.py` provides synthetic source-level
analogues of T37–T39: supported trigger with neutral invalidation, added qualitative
rationale, and contradictory counterevidence. It locks all nine table cells,
standalone support, empty claims, independent gates and evidence eligibility.
Original private T37–T39 fixtures/report receipts were not provided to this lane;
these are explicitly analogues, not a claim to have replayed those exact inputs.
No benchmark, real verifier run, paid data request or historical rewrite is needed.
A narrower supported verdict or support for negative conditions remains separate
future policy work. Integration, exact-head independent review and controlled
release belong to the coordinator; this document does not close the parent finding.

Validation on this branch: 101 backend tests passed across verifier characterization,
recommendation audit, recovery, adapters and fundamentals; eight frontend tests
passed for explanation rendering and recovery policy; TypeScript `tsc --noEmit`
passed. UI uses optional structural metadata without editing shared API/schema
files. No worker, persistence, authentication, spend or recovery controls changed.
An independent review must assess the pre-existing publication/provenance boundary:
`evaluate` itself does not reject a forged future `published_at` paired with past
`available_at`. Hardening that boundary would change eligibility and is outside
this lane's unchanged-decision scope. Do not claim that acceptance case as proven
by these tests or close the finding on this implementation alone.
