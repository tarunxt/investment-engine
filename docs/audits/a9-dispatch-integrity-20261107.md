# A9-004 dispatch integrity continuation

This is source hardening, not certification of an available INR cap.

## Implemented

- A metering context linked to an automated workflow cannot dispatch when its
  spending context is absent. A present spending context rejects conflicting
  owner, job or Celery retry identity.
- Admission receives the actual dispatch arguments and selected dispatch model,
  independently of the optional telemetry hash projection and original requested
  model dimension. Telemetry keeps those original dimensions unchanged.
- Worker configuration checks durable unresolved attempts under the scope lock.
  A crashed dispatch's reservation remains held and its scope is suspended before
  retry or redelivery can install a new spending context. Existing bound breach
  and settlement conflict states remain intact. This does not implement a full
  execution fence or prevent two workers racing before either reserves a call.
- Expanded-input validation counts JSON object keys, including schema property
  and tool names. It does not truncate input or change financial calculations.
- Telemetry-only tests explicitly isolate admission, while dedicated cap tests
  exercise actual admission and rejection before the mock transport.

## Local verification and limits

Source changes were prepared against PR1396 head
`07b5e68840e63d6fd5defce57d5c4867537a5558`. Supporting backend files came from
`9f3d2e844f59985b7857a68963a89d7871ebf79b`, overlaid with the exact PR1396 backend
files. This is a mixed-base integration fixture, not an exact current-main or
complete PR checkout. Network access was prohibited by the test runner.

Focused cap/settlement run: 86 passed, five PostgreSQL-only skips before the final
additional model-identity test. Metering regression: 118 passed after isolating
its telemetry-only fixture from real workflow admission. Initial metering run
had 66 failures because that fixture asserted a workflow identity without a
grant; its assertions were preserved.

The first broader run retained a real migration graph failure: 191 passed, five
skipped, one failed. Existing main's `auth_session_merge_001` and the unreleased
cap branch were two heads. A separate integration-only candidate moves the
unreleased cap migration parent to `auth_session_merge_001`, preserving applied
history. Combined tests with that candidate: **311 passed, five skipped**.
No runtime migration or PostgreSQL concurrency test was executed. This migration
composition must accompany integration onto the verified main lineage, not be
applied alone to the old branch. The new dispatch-integrity test file has eleven
cases; all eleven fail against the original source in the negative control.

## Release hold remains

`resolve_bound` still rejects every production adapter. No paid call, provider
activation, credential change, worker activation or deployment was performed.
Hidden SDK retries, full token/reasoning/tool envelopes, durable execution
fence/deadline composition, all paid paths and all-attempt invoice accounting
remain unqualified. If both spend and telemetry context are lost, this additional
context check alone cannot detect it. Ordinary untagged analysis keeps its
existing policy and must not be described as protected by the workflow grant.

Activation still requires current account-specific tariffs, bounded transport
and native tool billing, supported actual-INR settlement evidence and an all-in
INR FX/tax/fee ceiling. Historical receipts or terminal usage do not establish
those guarantees. The original INR20 per logical market workflow remains shared
across fanout, repair, retry and continuation, without grant renewal. A policy
decision is still required before extending that grant to ordinary analysis.
