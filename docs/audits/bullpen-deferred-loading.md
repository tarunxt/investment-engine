# Bullpen deferred history and detail loading

Approved follow-up to the focused offline Audit 9–12 batch, based on b611df685ef9b9eb069d20791659ff58c3c44eb7. No production or provider operation is included.

The live `BullpenAutoRunScheduleCard` remains the owner of schedule state, polling, action handlers and control rendering. Closed presentation is extracted to `BullpenScheduleDetails`; genuinely shared declarations live in `bullpenScheduleShared`. Neither module statically imports the live owner. Direct run routes import the detail screen directly, and the old exported entry points remain available through lazy wrappers.

History, Excel history, badge explanations and table dialogs load only when opened. Excel is first mounted when opened, then remains mounted with its original controlled `open` prop so subsequent close/reopen retains the original component lifecycle. Loading/error placeholders also respect that controlled closed state. No fields, ranking rules, financial calculations, request payloads or evidence interpretations are changed. A source comparison establishes that 199 original function bodies are byte-identical; the live owner's body differs only in the Excel first-use activation and controlled mounting.

`BullpenDeferredDetail` provides a local Suspense/loading and failure/retry boundary. Retry creates a fresh lazy instance, while the live owner remains mounted. Pending/failed panels support Escape, Tab/Shift+Tab and Close; closing restores focus to the opener. Loaded dialogs retain their existing callbacks and presentation. No eager preloading, financial invocation or new auto-recovery is introduced.

## Validation before build

- TypeScript no-emit passes.
- Existing CI frontend group: 679 tests, 678 passed, one existing skipped, zero failures.
- Styled offline browser fixture: 54 checks across both profiles at desktop/narrow widths. Closed history/detail chunks remain absent; first-open, reopen without another chunk request, loading Escape, focus return, retry and real history read-error recovery are exercised. Direct run-detail presentation renders. Zero external requests and financial actions.
- Expanded Bullpen suite: candidate 411 passed / 11 failed; untouched b611 baseline 408 passed / the same 11 failed. Three added loading-boundary checks account for the pass difference. No failing assertions were removed, skipped or quarantined. Formula/presentation source tests now read the extracted module set; independent boundary tests inspect the actual import graph.
- Lint retains the baseline two errors and five warnings; the new loading-boundary modules pass lint. Existing lint failures are not waived.

Fresh production build and unchanged packaged-runtime/browser byte gates must be measured on the committed source. A source split or dynamic import is not itself a budget pass. The baseline browser overage and all prior release holds remain recorded until actual verification establishes otherwise.

## Benchmark fixture qualification

The first numeric byte pass on the loading commit had three missing meaningful-UI markers. Debugging found that the existing benchmark supplied `{}` for provider collections and Bullpen read contracts, producing render errors instead of a usable console. Those results remain partial evidence. `fixtures/bullpen-performance.mjs` now supplies invented, read-only contract-shaped values (including providers as an array); no action is enabled. Missing meaningful readiness now fails the measurement explicitly. Numeric limits, sample counts and profile settings are unchanged. Both baseline and candidate must be rerun with this same corrected fixture; byte passes must not be inferred from error views.

The retained-view regression additionally verifies pending cancellation without a late overlay, single loader invocation, retained local state and focus restoration on controlled close. Actual Excel history is exercised through first open, close/reopen, read failure and recovery; its existing error/empty distinctions are unchanged.
