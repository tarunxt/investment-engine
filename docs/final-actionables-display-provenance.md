# Final Actionables display provenance

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
