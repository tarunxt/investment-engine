# Bullpen 008 P0 loss prevention

Bullpen 008 remains an isolated, six-stage, shadow-first workflow at `/console/bullpen008`. Bullpen 007 remains at `/console/bullpen-ai` with its original three-stage workflow, settings, schedules, alerts, plans, intents and records. P0 does not arm live execution and does not weaken the environment-variable and explicit-confirmation gates described in [Phase 2](bullpen008-phase2.md).

## Authority and safety boundary

Stage 4 is the only portfolio authority. It certifies buys, retained positions, trims, exits, mandatory time exits, scenario exposure and contingent policies. Stage 5 can only reproduce that target and translate each certified policy into a dormant immutable action. Stage 6 can only activate or execute an action in that plan; it cannot enlarge, redirect or substitute it. The minute monitor observes fresh quotes and evidence and evaluates existing policies. It cannot create a policy or a portfolio decision. Conditions requiring a new decision require a fresh Stage 1–4 run.

Production defaults remain `shadow_mode=true`, `execution_enabled=false`, `execution_mode=shadow` and `live_control_armed=false`. Shadow evaluation records `WOULD_ACTIVATE`, `WOULD_SUBMIT` and exact blockers, but does not perform a remote write.

## Deterministic tail-risk classification

Classifier `bullpen008-tail-risk-v1` combines the question, slug, category, tags, full rules, authoritative times, named entities and bounded military-action terms. It avoids classifying an unrelated contract from a generic word in incidental prose. An exact-calendar-date military or geopolitical contract, or one whose resolution window is at most 24 hours, is `single_day_high_shock`. Other military/geopolitical contracts are `high_shock_geopolitical`; remaining objective markets are `standard_objective`.

New entries fail closed with `SINGLE_DAY_HIGH_SHOCK`, `HIGH_SHOCK_ENTRY_WINDOW_LT_48H`, `HIGH_SHOCK_TIMING_UNRESOLVED` or `HIGH_SHOCK_RULES_INCOMPLETE`. An LLM can upgrade a tier but cannot downgrade deterministic output. Existing positions remain `accepted_monitoring`, with new entry disabled and exit review required. Existing speech exclusions, including `praise` and `praises`, are unchanged.

Default gross-loss caps are:

| Risk tier | Contract | Strict/common cluster | Joint-loss scenario |
| --- | ---: | ---: | ---: |
| `single_day_high_shock` | $5 | $5 | $5 |
| `high_shock_geopolitical` | $10 | $10 | $10 |
| `standard_objective` | $20 | $20 | $20 |

The most restrictive member determines a scenario cap. Existing holdings, active pending buys and unreconciled partial fills consume capacity. An exit releases exposure and proceeds only after reconciliation evidence. Expired or locked positions remain fully counted and are never treated as cash.

## Joint-loss scenario graph

Stage 3 keeps strict-resolution and common-catalyst clusters and adds the versioned joint-loss graph. Each node asks which one real-world event can make each chosen side lose and records the loss direction, deterministic and semantic links, sources, adjudication, risk tier and existing/pending/target gross loss.

The August 31 regression links “Iran targets an Arab country — NO” with “ceasefire continues — YES”, despite different parents and sides: the same verified Iranian escalation can satisfy the first contract’s YES condition (making held NO lose) and breach the second contract’s continuation condition (making held YES lose). Related blockade, Hormuz, peace-deal, retaliation and targeting contracts join when their complete rules and semantic adjudication establish the same driver. Missing membership, reasoned loss direction or unresolved adjudication blocks buying.

Stage 4 uses conservative gross loss. It never nets an offset unless identical resolution semantics deterministically guarantee it. The certificate includes per-scenario stress, maximum contract/strict/common/scenario loss, the binding cap, every rejected allocation, reduction, policy and complete hashes. A no-buy exit-only or resolution-hold target can certify while pre-existing untradeable exposure is over cap, but every buy remains frozen and remediation stays visible.

## Reward skew and conservative edge

For price `P` cents and allocation `A` dollars:

```text
quantity_shares = A * 100 / P
maximum_payout_usd = quantity_shares
maximum_profit_usd = maximum_payout_usd - A
maximum_loss_usd = A
reward_to_loss_ratio = maximum_profit_usd / maximum_loss_usd
```

Entries above 95¢ are rejected. Entries from 90¢ through 95¢ are limited to $5 and require strong evidence. A reward-to-loss ratio below 0.10 is rejected. Existing holdings stay monitored even when these entry rules fail.

The allocator uses:

```text
conservative_probability = chosen_side_llm_probability - uncertainty_haircut_pp
conservative_edge_pp = conservative_probability - chosen_side_market_odds
```

The deterministic haircut includes evidence quality, model confidence and disagreement, structural/data/information-shock risk, risk tier and available calibration error. Missing uncertainty inputs, low evidence, high disagreement or unverified evidence rejects the entry. Minimum conservative edge is 5 percentage points for ordinary markets and 10 for high-shock markets. The historical 0.25-point preference remains display-only/backward compatible and is not entry authority.

## Evidence and regime change

A high-shock packet requires at least two credible independent publishers, with publisher, URL, title, published/fetched timestamps, source type, extracted proposition, content hash, entity coverage, relevance and thesis effect. At least one source must be no older than 30 minutes. Empty, one-source, stale, timestamp-free, retrieval-failed or materially conflicting/unresolved packets fail closed. Social commentary is not authoritative without independent confirmation.

Deterministic regime flags include verified strikes, retaliation, ceasefire breach, official attack confirmation, authoritative imminent-retaliation warnings, emergency declarations, resolution-fact changes and evidence directly invalidating the held thesis. An active episode freezes buys/top-ups/averaging down, starts a 24-hour scenario cooldown, evaluates already certified exits and requires fresh Stage 1–4 analysis plus evidence-backed recovery. It never automatically buys the opposite side.

## Time exits and contingent exits

Stage 4 schedules a `single_day_high_shock` exit before the event day and, when feasible, at least 24 hours before the deadline. Other high-shock holdings exit 12–24 hours before their deadline. It also reduces when held-side odds reach the certified 95–98% profit zone or reward-to-loss falls below 0.10. Expired non-claimable positions retain hold-for-resolution handling.

Default contingent triggers are held-side odds below 85%, a 5-point decline in 15 minutes, a 10-point decline in 24 hours, thesis-invalidating evidence, regime change, the mandatory timestamp, reward-to-loss below 0.10 and a hard drawdown. Normally two fresh observations are required and persisted. A deterministically verified regime change or a greater-than-20-point 15-minute catastrophic move can activate immediately after the move is evidenced.

Every policy fixes the maximum shares, minimum sell price, slippage, spread, retry rules, expiry, scenarios, version and hash. A wide spread, insufficient liquidity or ambiguous remote outcome remains recoverable. A blocked limit exit is never converted into an unrestricted market sell. Duplicate delivery reconciles by stable idempotency key and remote ID rather than blindly submitting again.

## Continuous monitoring and drawdown

The existing every-minute Bullpen 008 task refreshes the wallet, stores immutable quote observations, refreshes applicable evidence, identifies trigger episodes, loads Stage 4 policies, acquires the shared account execution fence and records shadow/live validation. Email remains notification only and is never execution evidence.

The daily UTC baseline contains cash, marked liquidation value, pending/unreconciled state, external-flow neutralisation, wallet version and timestamp. IST display is retained in the UI where applicable. At the default $200 bankroll, a $6 (3%) drawdown freezes buys/top-ups/averaging down with `BUY_FREEZE_SOFT_DRAWDOWN`; a $10 (5%) drawdown enters `EXIT_ONLY_HARD_DRAWDOWN`, permits claims/cancellations/sells/trims, records pending buys that would be cancelled and activates applicable certified exits. All transitions and recoveries are durable.

## P&L and loss-prevention audit

Bullpen 008 attribution records run, decision, contract, side, strict/common cluster, joint scenario, entry/exit intent, trigger episode and calendar day, including entry basis, current/exit value, realised and unrealised P&L, fees, original maximum loss/profit, reward skew, raw/conservative edge, scenario loss/cap, exit policy and reconciliation state.

The loss-prevention audit reports whether each new safeguard would have rejected entry, reduced size, blocked a top-up, required an early exit, activated a contingent exit, frozen buys or entered exit-only mode. These are explicitly labelled counterfactual estimates; avoided-loss estimates are never actual realised results.

## Recovery and gap-risk limitation

Operators should inspect the immutable Stage 4 certificate, Stage 5 plan/policy hashes, activation observations, durable intent and remote reconciliation ID before retrying. Ambiguous submissions are reconciled first. Missing/stale wallet, quote, evidence, identity or hash data blocks action. A new portfolio choice always returns to Stage 1–4.

No risk control guarantees an exit price during an instantaneous gap, exchange halt, disappearance of liquidity or remote-system outage. An odds alert cannot eliminate gap risk because the market may move through every permitted limit before an observation, notification or submission completes. Prevention, small position sizing, common-catalyst/scenario control and pre-event exits are therefore the primary safeguards; alerts and contingent exits are secondary containment.
