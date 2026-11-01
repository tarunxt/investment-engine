# A10-002-R02: confidence semantics source inventory

Inspected repository source at `9a06d6fadc8bcaf27d2e23c86ea3d1206388f75d`
on `work/bullpen-analytics-20261101`. This is a source inventory, not a claim
about the active production prompt/configuration or empirical forecast quality.
No account data, saved private prompts, providers or runtime systems were read.
No strategy, prompt, parser, threshold, schema or live consumer is changed here.

**Calibration: Not established for every field below.** Numeric validation,
ordinal ordering, model agreement and plausible names do not establish forecast
calibration. A calibrated interpretation would require a specified forecast
outcome, horizon, population, cost/exposure scope, model version and independent
validation. Cross-field probability equivalence is **Not established**.

## Equity recommendations

| Actual field / source | Prompt meaning, units and range | Parser / storage | Aggregation and consumers | Status / limitations |
|---|---|---|---|---|
| `Confidence Score (0-100)` / `confidence_score` | `prompts/prompt-1.txt` and `frontend/lib/swingTrade.ts`: conviction + setup quality, declared 0–100 score. `frontend/lib/rebalance.ts` and `backend/app/domains/jobs/tasks.py` require numeric-only confidence cells. No specified success event or probabilistic horizon for confidence itself. | `jobs/output_contracts/schemas.py` declares column; `validation.py::validate_row` requires finite numeric-only 0–100, preserves original value; rebalance unavailable fields can remain `-`. `InvestmentRecommendationTable.tsx` canonicalizes header aliases. `google_sheets/stock_service.py` maps headers/position variants; `stock_models.py::confidence_score` is nullable Float. Storage typing is not itself a probability contract or proof all legacy imports passed current validation. | `prompts/prompt-2.txt` requests simple available-numeric average and descending confidence ordering; FinalActionables groups source rows and `summarizeNumeric` produces a representative displayed confidence. Model averaging is descriptive aggregation, not independent evidence. | A score of 80 remains 80, not an asserted 80% success probability. Historical/overridden prompt consistency and actual cohort calibration Not established. |

## Technical catalog, scan and final-actionable arithmetic

| Actual field / source | Meaning / units | Parser and aggregation | Consumers / limits |
|---|---|---|---|
| `SetupRow.confidence` in `frontend/lib/technicalSetups.ts` | Fixed authored setup-catalog rating; UI renders `/10` in `console/technical-setups/page.tsx`. It is not a stock-specific model forecast. | Static numeric constants (e.g. 8.2), sorted with catalog stock-count/direction rules. No probability estimation or empirical calibration performed by this module. | Catalog display and `setupListMarkdown()` feed technical scan prompt. Empirical basis for catalog ratings Not established by inspected source. |
| Technical scan table `Confidence Score` / `TechnicalScanResult.confidenceScore` | `FinalActionablesConsole.tsx::buildTechnicalScanPrompt` explicitly says to **copy** numeric confidence of the approved Primary Setup; no `/10`, `%`, average text or LLM counts. Nominal 0–10 catalog score. | Frontend parser accepts `confidence score`, `confidence`, `score`, `conviction` header aliases, retains normalized strings. `recommendation_audit/technical.py::technical_rows` requires declared table columns and preserves source string/hash; `agreed_technical` requires equal values across completed output revisions plus captured setup policy. Equal copied values are not independent calibrated forecasts. | Display and `technical-scan-confidence` contribution in final score; audit checks numeric 0–10 plus bullish/bearish direction. No conversion to event probability. |
| `technical-scan-confidence` in final arithmetic | Weighted decision-score term, not probability. Frontend uses effective direction multiplier, confidence bounds 0–10, denominator weight 2 and out-of-bounds denominator weight 3. | `runs/final_score_math.py::calculate_listing` mirrors existing UI arithmetic. A blank technical score falls back to rounded mean of equity `Confidence Score (0-100)` cells; the existing fallback strips characters and can include empty cells as zero. It does **not** divide 80 by 10 or 100. `getFallbackTechnicalConfidence` can also display equity score when technical confidence is absent. | Unsupported cross-scale equivalence is **Not established**. A synthetic fixture explicitly preserves fallback 80 with technical bound 10 rather than silently repairing strategy. This may require separate owner policy review. |
| Recommendation-audit technical confidence | Certification of source-derived arithmetic/structure, not investment truth. | `recommendation_audit/deterministic.py` requires confidence 0–10 and bias; applies detailed confidence weight × directional multiplier. `historical_score_reader.py` exposes captured matrix contributions. Frozen listing recomputation preserves its distinct frontend multiplier convention. | Do not assume audit and listing formulas are identical or that either validates confidence calibration. Existing differences are recorded, not changed. |

## Bullpen paths (live semantics preserved)

| Actual field / source | Prompt / units / range | Parser and aggregation | Consumers / limitations |
|---|---|---|---|
| Manual Bullpen row `confidence` | `frontend/lib/bullpen-ai.ts` and `polymarket/bullpen_llm_execution.py` prompt `Low|Medium|High`; separate from YES/NO probability/odds fields. Meaning is qualitative model conviction; no numerical event calibration definition. | Frontend string parsing and Stage2 row schema retain strings; execution validation passes the row through. | Manual display, execution context and trade-analysis capture. Do not equate High with a fixed probability. |
| Auto-live model output and consensus `confidence` | `polymarket_auto_live/llm.py` prompt uses `Low|Medium|High`. | `normalization.py::normalize_auto_live_confidence`: Medium/Moderate → Medium; High/Strong/Very High → High; other/missing → Low. Output parsing retains absent confidence as None before normalization where guarded. `llm.py::_pick_consensus_label` chooses modal label among successful/valid outputs; when the two leading counts tie, the implementation selects the lowest ranked label among all present labels, including a smaller-count label (Low=0, Medium=1, High=2); no labels returns None. | `engine.py::_confidence_below_minimum` and settings `min_confidence` (default Medium) are **live gating**; `CONFIDENCE_WEIGHT` Low=.55, Medium=.8, High=1 feeds candidate score with other factors. These are existing strategy heuristics, not calibrated probabilities. No changes authorized by this inventory. |
| Bullpen008 `confidence` | `bullpen008/engine.py` prompt categorical Low/Medium/High; parser rejects other labels. | Stage4 maps Low=.25, Medium=.65, High=1, combines with evidence rank in `.15 * ((evidence + confidence)/2)` inside composite ranking. No outcome-calibration step. | `risk_controls.py::reward_and_edge_protection` uses confidence haircuts High=1, Medium=3, Low=7 percentage points (unknown=10), alongside other penalties; missing uncertainty inputs reject. This is a **live ranking/risk path**. `historical_calibration_error_pp` is another nonnegative penalty input, defaulting missing to zero; no producer/independent validation reference was found in repository search. Its name does not certify calibration. |
| Trade-analysis `buy_confidence`, `sell_confidence`, per-LLM `confidence` | Derived heuristic numeric score nominally 0–1, not a probability. `bullpen_trade_analysis/service.py` applies `confidence_score_from_value` to capture context/LLM entries and retains raw context/parsed output separately. | Helper accepts numbers ≤1 as fractions; >1 divides by 100 and clamps, with categorical High=.85, Medium=.6, Low=.25. Thus 1 → 1 but 1.01 → .0101, and Strong differs from live normalizer. None/unrecognized → None. This magnitude-based legacy mapping does not establish incoming units. | `compute_trade_tags` uses .75/.4 tag boundaries; `build_rule_checks` uses .4 and treats missing as passing its descriptive rule. Record/schema confidence fields remain nullable. These are analysis tags/checks, not a calibrated forecast contract. No mapping/boundary changes made. |
| Trade review confidence buckets and learning flags | `analytics.py::confidence_bucket` groups existing numeric score (<.4 Low, <.7 Medium, otherwise High; missing Unknown), distinct from capture tag .75 boundary. | Known-outcome selected-cohort means are descriptive raw-dollar summaries. Version `bullpen-descriptive-v2` returns alignment None / Not evaluated and no reinforcement or confidence-increase recommendation. | A high recorded confidence/loss co-occurrence remains a human review lead, not proof of miscalibration. Historical stored flags remain original evidence. These changes do not alter live confidence paths above. |
| `Stage2EvidenceClaim.confidence` | Separate evidence-claim support heuristic, schema 0–1 (default 0), not trading confidence or resolution probability. | `polymarket/event_preflight.py` constructs .3 generic/.7 other source claims. `polymarket_auto_live/evidence.py` constructs clamped source-relevance score .2–.95. | Evidence packets, prompt/audit presentation. Source relevance/support is not forecast correctness. Cross-source calibration Not established. |
| `yes_definition_extraction_confidence`, `deadline_confidence` | Rule extraction/temporal provenance labels: high/medium/low/none or unresolved, not outcome probabilities. | `polymarket_auto_live/rules.py` derives labels from rule/date extraction; Stage2 models preserve them. Frontend historical deadline adapter can mark medium or unresolved. | Rule/deadline gates, prompt evidence, Stage2 audit snapshots. Existing gate use of high/medium is unchanged; no mapping to model conviction or calibration. |

Bullpen raw probability fields (`llm_yes_probability`, `llm_no_probability`,
`fair_yes_probability`, chosen-side probability) have their own 0–100 probability/
odds contracts and consensus computations; they are not the categorical
`confidence` field. `llm.py` probability median/trimmed-mean consensus must not be
confused with modal confidence aggregation. None of those aggregations proves
calibration. Cost-driver recommendation confidence is an operational cost-analysis
field and is outside this investment-confidence inventory.

## Acceptance and policy boundary

A10-002-R02 inventory deliverable: source paths, actual meanings, units/ranges,
aggregation and active consumers identified above; unsupported equivalence and
calibration marked Not established. Synthetic compatibility tests in
`backend/tests/test_confidence_semantics_inventory.py` execute existing equity
validation, technical table parsing/fallback arithmetic, Bullpen normalizers,
label consensus and conservative review. The technical prompt source assertion
only verifies its copy instruction; it is not runtime/provider acceptance.

This does **not** close calibration/forecast semantics policy or enable validated
learning under A10-002-R03. Catalog empirical justification, mutable active prompt
consistency, incoming legacy numeric-unit provenance, technical equity fallback
policy, probability outcome/horizon and independent chronological validation
remain unresolved. Existing test counts certify only tested component behavior.
Integrator coordination: this change touches this document, the acceptance ledger
and a new isolated test file only; shared analytics/service/schema and all live
strategy files remain untouched.

## Explicit event, horizon and abstention inventory

| Field family | Outcome/event confidence purports to predict | Confidence horizon | Abstention semantics |
|---|---|---|---|
| Equity 0–100 conviction/setup score | Not established: confidence is not tied to a binary success definition, target hit, return sign or specified cost-adjusted event. Other recommendation columns do not define confidence. | Not established for confidence itself; named rationale horizons and `Weeks` do not establish a calibrated confidence horizon. | Not established as a forecast abstention policy. Missing values/`-` are data unavailable states; Hold is a separate action. |
| Technical catalog/scan 0–10 | Not established as an outcome event; prompt requests copying Primary Setup's fixed catalog rating. | Not established as a forecast horizon; daily/weekly chart instructions are observation context. | Not established as statistical abstention. Missing/invalid technical rows and audit errors are evidence states, not a calibrated reject option. |
| Bullpen ordinal model/consensus confidence | Not established whether label refers to probability accuracy, evidence sufficiency, side recommendation or conviction. Exact market YES definitions and separate probability fields are available but do not define the confidence event. | Not established for confidence itself; a market resolution deadline is not a demonstrated confidence horizon. | `recommended_side=SKIP`, rejected uncertainty inputs and execution blockers are separate existing controls. Label missingness can normalize to Low in live paths; it is not proven abstention. |
| Bullpen trade-analysis scalar | Not established; it is a heuristic normalization of numeric or ordinal capture input. | Not established; no confidence outcome/horizon contract accompanies the derived scalar. | Missing/unrecognized input → None, conservative v2 alignment → Not evaluated; these are missingness/analysis states, not calibration. |
| Evidence-claim / rule/deadline confidence | Evidence support, source relevance or extraction certainty rather than trade outcome. A forecast event is Not established. | No outcome forecast horizon established; deadline extraction describes a date, not probability performance. | Explicit none/unresolved/unverified states are retained by their source contracts. They cannot be equated with model-label Low or a trading abstention probability. |

Preservation check: synthetic capture fixtures verify original confidence value,
model identity, source timestamp and raw output remain in the existing parsed/raw
evidence while derived heuristic confidence stays separate. Subsequent conservative
review leaves those inputs unchanged. Equity validation preserves 80 as 80;
technical table parsing preserves 8.2 as 8.2; no new rescaling is introduced. These
checks establish compatibility/preservation, not that 80, 8 or .8 share meaning.
