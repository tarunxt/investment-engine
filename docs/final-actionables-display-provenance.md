# Final Actionables display provenance

## Run matching retrieval states

Both India and US run groups distinguish loading, failed retrieval, retained
source data, and confirmed empty results. An unfinished or failed request does
not imply no matching run or zero consolidated runs/stocks. A retained source
group is labeled while refreshing or after a failed refresh. A successful check
distinguishes no qualifying run from a selected group with no parsable stock
rows. The source disclosure preserves the saved input bundle (or full legacy
prompt), source IDs and timestamps verbatim; missing text/timestamps are labeled
unavailable. It does not infer missing sources or claim corrupted data.

The existing matcher and counts remain unchanged: market/stage identity,
completed/partial status or saved usable model output, latest creation time,
and whitespace-normalized input bundle equality (full prompt for legacy runs).
Existing request-generation guards reject stale success and failure responses.
These are read-only presentation changes with no provider, scan, execution,
history-write, or account side effects.

The current recommendation view previously combined the latest portfolio
quantity with the first model's Units Change/Final Units and a multi-model mean.
For example, two independent jobs proposing changes of 6 and 5 for a captured
zero holding could display current 6, change 6, final 6 beside a mean of 5.5 after
the portfolio changed. That mix is not a coherent calculation.

Current formula held status, current value, and quantity arithmetic now share
one explicit position context. A latest complete snapshot supplies current
holdings; otherwise captured model holdings are labeled as the fallback. The
consolidated quantity fields are derived together. Known-zero holdings cannot
reuse old sell/trim quantities. Model consensus remains separately labeled, raw
job rows remain unchanged, and distinct same-model jobs retain their votes.
India action quantities still round to whole units; the displayed model/formula
mean is labeled before rounding. Score thresholds, weights, and order controls
are unchanged.

Saved server history remains authoritative. Reconstructed history uses captured
model holdings and conservatively excludes scans/jobs created after the original
run's creation; mutable export/update timestamps cannot admit newer evidence.
The UI identifies reconstructed rows and current formula settings. The derived
history cache advances to version 4; prior stored versions are ignored without
rewriting or deleting saved records.

The parser tries supported Markdown fallbacks before logging a terminal JSON
failure. Malformed output remains visible. Optional derived cache writes skip an
entire snapshot on quota failure, preserve existing storage and loaded data, and
avoid repeated serialization for that key until reload. No source rows are
trimmed to fit and no unrelated storage is evicted.

Offline regressions cover the arithmetic example, independent samples/dissent,
zero versus unknown holdings, India/US rounding, historical temporal isolation,
cache quota/session isolation, and valid Markdown versus terminal malformed
JSON. These changes do not promise faster cold history hydration or validate
historical model research. No production trading action is performed.

## Historical action and score labels

Legacy backfill stores model-consensus actions independently of an average of
captured rationale scores. If rationale scores were absent, that legacy writer
used its original action-code average instead. Neither is the weighted Calculated
Score or an inverse of today's model-action input weights. The audit history now
labels the recorded score method using `formula_version` and the saved legacy
inputs; incomplete method evidence stays explicitly unknown. Original actions and
scores are never changed to fit current formula settings.

The model-action weight table is labeled as an input table. Current formula range
labels now show inclusive/exclusive endpoints explicitly; matching conditions and
holdings-dependent Buy New/Add More behavior are unchanged. Historical frozen
matrices continue to display saved actions and rules, with the unrounded saved
score available in the score tooltip.
