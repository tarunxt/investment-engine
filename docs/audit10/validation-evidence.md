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
| A10-001-R03 | Conservative original lineage eligibility checks and synthetic timing/identity/action/FX cases | Actual canonical mapping, source/adjustment vintages and original evidence unavailable; existing T05–T17 report fixtures not supplied as a pinned corpus |
| A10-001-R04 | Explicit chronology/dependency/overlap/embargo checker and tuning-ledger protocol | Populated frozen split, maturity, dependency/embargo rationale and independent holdout blocked on contract/corpus |
| A10-001-R05 | Known-zero/unknown/partial cost coverage checker and reconciliation requirements | No actual execution feasibility, outcomes, all-in costs or comparator reconciliation; calendar/illiquidity/partial fill runner not implemented |
| A10-001-R06 | Reproducible hashes and honest `not_established` status | Independent frozen historical evaluation blocked; this is tooling, not empirical closure |
| A10-001-R07 | Versioned formula hash, action boundaries, boundary margin and deterministic sensitivity | New labelled synthetic 35 baseline / 665 scenario grid; existing boundary/failure tests retained. It is not an original Audit10 fixture rerun or prompt/model robustness evidence |
| A10-001-R08 | CLI status, exact gaps, per-record coverage and separate validation dimensions | No economic-validation success state until independent evaluation; stale/failed corpus adjudication needs original evidence |

No parent finding is closed. External task IDs/dedupe remain with the sole task writer.
Integration, security-first sequencing, exact-head CI and independent review remain
with the coordinator. This lane must not merge, approve, deploy or restart workers.
