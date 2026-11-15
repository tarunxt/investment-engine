# A7-L05: stage status provenance

Validated against fetched `origin/main` at `da317a1097cef97089e3a745b9e20b4952af6a48`.
Scope is local presentation and selection of saved evidence. No provider reruns,
production data reads, broker actions, exports, or publication occurred.

## Demonstrated defects and correction

The idle hydration callback builds an Actionables summary from independent saved
Rebalance/Technical sources, including a timestamp from a failed Technical run.
That timestamp is an evidence timestamp, not proof of final-stage execution.
The ledger previously titled all timestamps “Saved time” and omitted source IDs.
It now labels historical evidence and derived summaries separately, calls the
column “Evidence time”, and shows the exact timestamp/count/input source references
in the selected evidence panel. No common workflow membership is inferred.
Ordinary workflow updates clear prior hydration provenance so it cannot survive
as the label on a new stage update. Missing source metadata stays unavailable.

A saved Actionables stage's own completion timestamp also contributed to the
derived timestamp. The existing reconciliation selected the derived value on an
equal timestamp, hiding the saved final status and count. Actionables now prefers
the saved stage on a tie. Other consumers retain their existing reconciliation.
Newer derived evidence remains available. No financial derivation or provider
count policy is changed; all source records and permissions are preserved.

## Verification

- 25 targeted hydration/resilience/stage-format tests pass.
- 35 stock-flow/whole-share regression tests pass.
- TypeScript `tsc --noEmit` passes.
- Actual WorkflowStageLedger browser fixture passes: India/US, missing, zero,
  partial, stale, failed, queued, selection, repeated dialogs, keyboard focus,
  narrow horizontal scroll and preserved callback wiring. Added failed Technical
  plus derived Actionables fixtures retain distinct identities through reload and
  repeated selection, with no execution callbacks triggered.
- Isolating the original tie preference against the new hydration fixture fails
  the saved-final regression (`derived` versus expected `saved`); restoring the
  correction passes. This is a demonstrated pre-fix selection failure, not a
  pre-existing test-suite failure.
- Synthetic screenshot `/tmp/auto-stages-evidence/derived-provenance.png` was
  visually inspected. Browser evidence stays local, outside tracked files.

## Acceptance limits and dependencies

The initial materialization used a coordinator-supplied malformed identifier and
returned `NOT_FOUND` / HTTP 404. That result did not establish that the canonical
file was inaccessible. After the coordinator supplied the corrected canonical
search result, the current Library complete-search-result download helper failed
before transfer with `hosted apps tools/list request failed: network`. One bounded
retry with network access explicitly enabled returned the same failure. No PDF
bytes or pixels were available in this executor. Investigation therefore still
uses the supplied verbatim finding and preservation map; canonical source pixel
verification remains pending. No guessed transfer URLs or source replacements
were used.

The investigated workflow's actual provider jobs, terminal children, saved stage history and
production derived input IDs were not available in this environment. Its Threats
transition and provider count reconciliation therefore remain unverified. No
production remediation is claimed. The UI explicitly directs workflow stage
state without saved provenance to History for invocation identity; it does not
invent an invocation ID for legacy or locally restored state.

Audit 6 overlaps were reviewed in the current source: `mergeStageEvidence` keeps
whole source records separate, and the existing historical-stage adapters preserve
saved lifecycle evidence. This change preserves those contracts and adds the
Actionables-specific equal-time preference and provenance disclosure.

The existing derived count fallback uses truthy checks and can treat an empty
parsed consensus as unavailable. This work does not decide whether an empty parse
means a verified zero; that needs saved input/output evidence, not a new financial
rule. Full acceptance still requires authorized read-only comparison with the investigated
workflow and the original PDF evidence. Deployment is owned by the sole integrator.
