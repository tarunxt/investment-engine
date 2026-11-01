# Audit10 offline investment validation evidence v1

This lane adds an offline companion contract, not a new capture schema or trading
policy. Existing frozen rows, prompts (including aggressive / 1–3 month language),
raw/effective scores, actions and reconstruction provenance remain unchanged.
No database migration, provider call, source refresh or runtime action is added.

Run from `backend` with an already authorized, privacy reviewed local JSON input:

```
python scripts/replay_recommendations.py input.json local-report.json --evidence-only
```

Do not commit the input or generated report. The input contains `records`, optional
`population`, and optional `validation_contract`. Missing contract defaults to
`draft-unapproved` with every investment choice unset. A separate immutable contract
version is required for each market/strategy. `ValidationContract` lists the required
owner choices; it does not choose an objective, benchmark, costs, horizon, risk target,
sample threshold, embargo or confidence semantics. Approval/freeze timestamps require
timezones and must precede recorded first result inspection. Software cannot attest
an approval identity or prove that inspection has not already occurred.

The inventory hashes the supplied record corpus, projects only approved metadata
fields, retains missing original timing/version fields as missing, and counts every
supplied record. Record `population_state` distinguishes eligible/excluded/failed/
partial/abstained/missing/unknown. Outcome states distinguish known/unknown/unresolved/
censored/pending maturity. The population declaration requires attempted count,
source/universe manifest hashes, selection limits, pagination and historical universe
coverage. A matching declaration is a reconciliation check, not proof that an archive
is the complete population. No actual authorized historical corpus is supplied here.
Source IDs themselves require privacy review; do not publish any actual report.

Lineage checks reject unknown/future/naive times, observed reconstructions, unverified
identity and missing original hashes/versions or corporate action/share-unit/FX
provenance. They do not authenticate these assertions or repair source records.
Derived enrichment must be retained separately, linked by source hash and labelled
with derivation time/method; it cannot replace an original field. Split checks consume
explicit develop/tune/test rows, outcome windows and dependency groups; they reject
crossing groups and overlapping windows. The caller must supply a justified embargo;
no interval is chosen. A new independent test period is required after holdout tuning.
Maintain an append-only tuning ledger containing contract/corpus/code hashes, change,
reason, selected parameters, original-output IDs, split version and inspection times.

Cost coverage distinguishes known zero, known nonzero, partial and unknown for each
component. Synthetic fee/slippage defaults in the existing toy simulator remain
synthetic assumptions. Their outputs are not evidence of actual costs, feasible
fills, settlement, liquidity, market calendars, terminal outcomes or fair comparator
reconciliation. Cash conversion, FX, tax and financing require explicit treatment.
5/20/60 horizons remain eligible price points; drawdown is sampled at supplied points.
No annualization, Sharpe, calibration or portfolio advantage is inferred.

The CLI always reports economic effectiveness, confidence calibration and model
robustness as `not_established`. Workflow completion and deterministic replay are
separate dimensions. Exact missing gates, contract version/hash and corpus hash are
reported. Independent economic evaluation is intentionally unavailable until the
owner-approved contract and complete authorized original evidence exist. A supported
claim verdict and a passing synthetic test cannot establish investment effectiveness.

## Distinct recommendation tracking

| ID | Delivered here | Remaining acceptance / blocker |
| --- | --- | --- |
| A10-001-R01 | Versioned draft contract and approval ordering checks | Owner must approve every policy choice before results; no approved contract supplied |
| A10-001-R02 | Read-only metadata projection, denominator/gap checks | Authorized complete original population/universe/pagination corpus unavailable; declaration cannot prove completeness |
| A10-001-R03 | Conservative original lineage eligibility checks and synthetic timing/identity/action/FX cases | Actual canonical mapping, source/adjustment vintages and original evidence unavailable; original T05–T17 assertions now rerun unchanged from the checksum-verified author handoff (see local follow-up receipt) |
| A10-001-R04 | Explicit chronology/dependency/overlap/embargo checker and tuning-ledger protocol | Populated frozen split, maturity, dependency/embargo rationale and independent holdout blocked on contract/corpus |
| A10-001-R05 | Known-zero/unknown/partial cost coverage checker and reconciliation requirements | No actual execution feasibility, outcomes, all-in costs or comparator reconciliation; calendar/illiquidity/partial-fill runner now implemented with supplied-evidence checks; actual reconciled inputs unavailable |
| A10-001-R06 | Reproducible hashes and honest `not_established` status | Independent frozen historical evaluation blocked; this is tooling, not empirical closure |
| A10-001-R07 | Versioned formula hash, action boundaries, boundary margin and deterministic sensitivity | New labelled synthetic 35 baseline / 665 scenario grid; existing boundary/failure tests retained. Original T21–T28 assertions also pass from the author handoff; the 35/665 grid remains newly constructed synthetic coverage, not the original grid or prompt/model robustness evidence |
| A10-001-R08 | CLI status, exact gaps, per-record coverage and separate validation dimensions | No economic-validation success state until independent evaluation; stale/failed corpus adjudication needs original evidence |

No parent finding is closed. External task IDs/dedupe remain with the sole task writer.
Integration, security-first sequencing, exact-head CI and independent review remain
with the coordinator. This lane must not merge, approve, deploy or restart workers.


## Local follow-up: ready work completed without historical predeclaration

Current strategy stays unchanged. No current owner question blocks this tooling.
Positive investment or calibration conclusions remain conditional on actual
approved policy and authorized evidence.

R02: `retained_inventory.project_retained_metadata` reads explicitly selected local
JSON files, with 200-file / 2 MB-per-file / 10,000-row-per-source / 10,000-projected-
record bounds. It records exact stored-file SHA-256 hashes, source counts, parse/
shape exclusions and truncation; it never opens a database or refreshes sources.
An actual local probe inspected 25 JSON verification artifacts beneath
`docs/audits` and `docs/visual-audit`; none contained original recommendation
decision metadata. The two exact author-provided retained-source paths were absent
in this executor. Two account trade archive paths were identified and excluded
without opening because they are outside recommendation metadata scope. Shared
and Library staging roots contained no files. The local receipt is retained in
`/workspace/scratch/audit10-original/retained-metadata-probe.json`; do not publish it
or infer an empty historical population. The precise missing input is a bounded,
privacy-safe projection of the author's retained workflow/lineage sources, with
source hashes, original run/job/output IDs and declared selection/pagination limits.

R03: the author fixture decoded once to 11,396 bytes and verified SHA-256
`3a8875226e8b68af0d114667704a4408b23cb4751d9187666c6be4c630c83569`
before review. The unchanged safe prefix T01–T28 passed 28/28, including T05–T17
(13/13) and T21–T28 (8/8). Harness adaptations only redirect ROOT to this checkout,
omit an unused Bullpen analytics import, and select the safe prefix. Assertions
and financial fixture values are unchanged. Old T29–T36 defect characterizations
were not executed and are not represented as current regressions or acceptance.
The source fixture, adapted harness and results remain local in
`/workspace/scratch/audit10-original/`; no private source was added to the repository.

R04: `split-template.json` is explicitly a blank draft, with no frozen date,
embargo, dependency or historical selection invented. Split guards additionally
reject result inspection before declared label maturity. The empty
`tuning-ledger-template.json` and `tuning_ledger.ledger_gaps` record and check freeze,
inspection, tuning, selection and retries. Entries link the exact prior-entry hash,
contract/corpus/code hashes, time, split version, original saved-output IDs and
reason. Selection events also require selected parameters. Inspection must use the
frozen inputs and mature test window; tuning consumes inspected periods and a new
freeze must have a different, nonoverlapping test period. This is protocol checking,
not proof that any historical holdout was untouched. Preserve entries append-only;
never regenerate an original model answer. Missing events remain missing.

R05: run `python scripts/reconcile_execution_evidence.py input.json local-report.json`
from backend for a single offline incremental-position reconciliation. The supplied
fixture must declare market/security/currency, verified identity, original completion,
decision and fill-window times, observation time, lot size, settled available cash,
available position, corporate-action reconciliation hash and share-unit vintage.
Sessions explicitly declare open/closed status and boundaries; the tool does not
fetch calendars or treat absent holidays as trading days. Each price point supplies
its session, execution price, tradability, capacity, availability, source hash and
per-fill cost evidence. Fills occur strictly after the decision inside the supplied
session/window. Duplicate instants are excluded together. Capacity is rounded down
to the supplied lot; cancellation of the remainder is explicitly selected. Unknown
capacity, no executable lots, closed sessions and insufficient settled cash or
positions remain exclusions. No financing, shorting or automatic order is inferred.

Cost totals must explicitly refer to the filled units and currency. Execution prices
include price-side spread/slippage, so incremental spread/slippage charges must be
explicitly evidenced zero to avoid double counting. Missing costs withhold the net
mark and leave execution feasibility unknown; they are never zero-filled or
proportionally manufactured for partial fills. Terminal marks require declared
price, identity/currency, share-unit vintage, source and availability; incompatible
split vintages or unsupported liquidation rules remain unresolved. Censored,
unknown, unresolved and pending-maturity outcomes are preserved. The only supported
terminal calculation is a supplied-price incremental cashflow mark. It is price-only; distributions and total-return outcomes require separate
reconciliation. It does not choose an investment outcome, comparator, liquidation cost, annualized return or
portfolio effectiveness. Input hashes and exclusion reasons are retained; raw inputs
are not modified. Real terminal events, market-size feasibility, settlement, all-in
costs and approved comparator evidence remain genuine data gates.

Publication of this follow-up is held by the coordinator. No push, PR attempt,
merge, deployment, provider call, live export or host action is authorized here.
