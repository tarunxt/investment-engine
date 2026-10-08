# Captured Stock Details and Rebalance Stock Flow

Captured Stock Details separates the provider recommendation, saved formula action and score, current formula calculation, and saved sizing. Its default comparison contains **Quick overview of findings** and **In-depth details**. Blue, amber and red notices also have text and icons; none certifies that a trade is safe.

Missing preceding frozen evidence produces **insufficient evidence**. Older saved suggestions remain visible as historical context, but cannot reconstruct the original formula, holdings, source availability or policy. Current technical inputs and weighted contributions are observations now. They do not replace an original snapshot. Scores display to two decimal places and dates have explicit IST formatting.

**Verify stored evidence** checks the frozen comparison and seeks supporting and opposing evidence. **Recheck stored evidence** requests a fresh stored-data check. Both use zero external spend and fetch no fresh market data. Same-model agreement and post-hoc explanations do not establish independent support. Independent API verification remains subject to existing explicit capability and budget controls; unknown capabilities fail closed. A current calculation capture stays separate from the historical pair. Selection changes reset the session, and canceled or stale responses cannot attach to a different security, run or formula.

## Whole-share review

A fractional trim of a one-share India holding remains a blocked review candidate. **Keep position** creates no order. **Review full exit** requires an explicit choice followed by separate row selection. Default selection, quantity edits, quote preparation, clipboard, Publisher payload and direct-submission preflight preserve the gate. A blocked trim contributes no projected buying power. Choices lock during submission or after recorded submission. Normal whole-share trims and US fractional quantities keep their existing behavior.

New audit sizing records use `whole-share-trim-review-v2`. Existing append-only records retain their original policy and sizing. These controls improve the transparency of a suggested action; they do not establish investment merit.

## Rebalance Stock Flow

Zerodha and INDmoney use the shared Swing parser. Swing rows do not require a rebalance Action column. Per-job diagnostics distinguish populated output, explicit empty output, missing response, unparseable response, partial output, incomplete work and failed or canceled jobs. Run and job IDs, stage selection, missing technical coverage, partial hydration and cached refresh fallback remain visible.

Rebalance grouping uses a recorded sequence or a bounded same-input time window. An unavailable input fingerprint does not combine unrelated runs. Each independently selected stage retains its own source context. Older history cannot overwrite a newer complete stage record, including its zero count, date or cost.

Profile GET provides an additive `preferences_writable` capability. Threshold loading makes no write. Saving requires an actual edit and a confirmed writable capability; saves serialize and compensate when an edit reverts while an earlier write is pending. Read-only recovery values are labeled local previews. Failed or unconfirmed persistence is never labeled saved. The recovery financial-write policy is unchanged.

## Validation

Focused offline checks cover deterministic policy, missing evidence, stale sessions, the actual Swing parser, whole-share selection and submission gates, threshold persistence races, and stage-history merge behavior. The mocked React browser harness is `frontend/scripts/review-reversal-flow-ui.mjs`, with `frontend/scripts/test-recommendation-audit.mjs` retained as its entrypoint. It uses synthetic fixtures and aborts external HTTP(S) requests. It is not a production-data or full basket execution test.

Historical reversal validation needs original attempted coverage, immutable source records, decision-time holdings and formula versions, canonical instrument identity, and source publication availability. A walk-forward evaluation must include failed and omitted runs, adjusted tradable prices, explicit fees and slippage, exposure flips by provider/formula/sizing layer, holding-context exclusions, and chronological holdout evaluation. Missing evidence must stay visible; fixture success is not a robustness or profitability claim.
