export type AutoLiveCheckStatus = "pass" | "watch" | "fail";

export type AutoLiveDecision =
  | "BUY_NEW"
  | "ADD_MORE"
  | "HOLD"
  | "TRIM"
  | "EXIT"
  | "SKIP";

export type AutoLiveRiskStatus = "Ready" | "Watch" | "Blocked";

export type AutoLiveStageDefinition = {
  label: string;
  description: string;
};

export type AutoLiveAuditEntry = {
  label: string;
  status: AutoLiveCheckStatus;
  detail: string;
};

export type AutoLiveGuardrailCheck = {
  label: string;
  status: AutoLiveCheckStatus;
  detail: string;
};

export type AutoLiveExecutionCheck = {
  label: string;
  status: AutoLiveCheckStatus;
  detail: string;
};

export type AutoLiveRow = {
  id: string;
  kind: "active" | "candidate";
  market: string;
  category: string;
  side: "YES" | "NO";
  currentPrice: number;
  fairProbability: number;
  edge: number;
  score: number;
  currentExposure: number;
  targetExposure: number;
  proposedOrder: string;
  decision: AutoLiveDecision;
  riskStatus: AutoLiveRiskStatus;
  reason: string;
  lastUpdated: string;
  evidenceSummary: string[];
  llmConsensus: {
    models: number;
    agreementPct: number;
    medianProbability: number;
    spread: number;
    dissentSummary: string;
  };
  sizing: {
    bankrollPct: number;
    stakeUsd: number;
    maxLossUsd: number;
    reserveAfterTradeUsd: number;
    explanation: string;
  };
  stageAudit: AutoLiveAuditEntry[];
  guardrailsChecked: AutoLiveGuardrailCheck[];
  executionChecks: AutoLiveExecutionCheck[];
};

const STAGE_FLOW_LABELS = [
  "Market scan",
  "Market rules",
  "Evidence refresh",
  "LLM consensus",
  "Sizing & guardrails",
  "Portfolio rebalance",
  "Limit-order execution",
] as const;

export const AUTO_LIVE_STAGE_FLOW: AutoLiveStageDefinition[] = [
  {
    label: STAGE_FLOW_LABELS[0],
    description:
      "Scan open Bullpen markets, dedupe stale listings, and classify markets into tradable themes.",
  },
  {
    label: STAGE_FLOW_LABELS[1],
    description:
      "Parse resolution rules, venue mechanics, and timing windows before evidence is shared downstream.",
  },
  {
    label: STAGE_FLOW_LABELS[2],
    description:
      "Refresh shared evidence, source freshness, and conflict flags so stale notes cannot auto-trade.",
  },
  {
    label: STAGE_FLOW_LABELS[3],
    description:
      "Run multi-model consensus, compare disagreement bands, and normalize fair probabilities.",
  },
  {
    label: STAGE_FLOW_LABELS[4],
    description:
      "Apply edge thresholds, bankroll sizing, reserve rules, and all doctor plus balance guardrails.",
  },
  {
    label: STAGE_FLOW_LABELS[5],
    description:
      "Compare current exposure versus target exposure and generate only the deltas that matter.",
  },
  {
    label: STAGE_FLOW_LABELS[6],
    description:
      "Stage live limit orders, run pre-trade checks, and submit only when every gate is green.",
  },
];

function buildStageAudit(
  entries: ReadonlyArray<readonly [AutoLiveCheckStatus, string]>,
) {
  return STAGE_FLOW_LABELS.map((label, index) => ({
    label,
    status: entries[index]?.[0] ?? "watch",
    detail: entries[index]?.[1] ?? "Waiting for the next automation cycle.",
  }));
}

export const AUTO_LIVE_ACTIVE_ROWS: AutoLiveRow[] = [
  {
    id: "iran-fifa-2026",
    kind: "active",
    market: "Will FIFA expel Iran before the 2026 World Cup?",
    category: "Geopolitics / FIFA",
    side: "YES",
    currentPrice: 43,
    fairProbability: 58,
    edge: 15,
    score: 87,
    currentExposure: 1800,
    targetExposure: 2400,
    proposedOrder: "Buy YES $600 @ 0.44 limit",
    decision: "ADD_MORE",
    riskStatus: "Ready",
    reason:
      "Fresh federation pressure, three-source evidence overlap, and a tight disagreement band keep the position under cap.",
    lastUpdated: "2026-06-21T10:14:00+05:30",
    evidenceSummary: [
      "FIFA disciplinary timeline was refreshed inside the last 22 minutes.",
      "Shared evidence pack now has Reuters, AP, and federation statements aligned on timing risk.",
      "Order book still supports a sub-44 limit without crossing the spread.",
    ],
    llmConsensus: {
      models: 5,
      agreementPct: 84,
      medianProbability: 58,
      spread: 7,
      dissentSummary:
        "One model assigns lower urgency because sanction timing could slip into the tournament window.",
    },
    sizing: {
      bankrollPct: 2.4,
      stakeUsd: 600,
      maxLossUsd: 600,
      reserveAfterTradeUsd: 17450,
      explanation:
        "Adds 2.4% of bankroll while staying under market, theme, and daily loss-stop limits.",
    },
    stageAudit: buildStageAudit([
      ["pass", "Bullpen scan found fresh order-book depth and no duplicate listing."],
      ["pass", "Resolution text still matches the stored rules checksum."],
      ["pass", "Evidence cache refreshed with three unique sources and no conflicts."],
      ["pass", "Consensus median stayed above the minimum edge threshold."],
      ["pass", "Sizing cleared exposure, reserve, and disagreement checks."],
      ["pass", "Rebalance delta is positive and below the single-trade cap."],
      ["watch", "Waiting for the next live limit-order window to submit the ladder."],
    ]),
    guardrailsChecked: [
      {
        label: "Max single trade",
        status: "pass",
        detail: "$600 is below the $1,250 single-trade cap.",
      },
      {
        label: "Max market exposure",
        status: "pass",
        detail: "$2,400 target stays below the $3,000 market cap.",
      },
      {
        label: "Cash reserve",
        status: "pass",
        detail: "Reserve remains above the $5,000 minimum after fill.",
      },
      {
        label: "Max LLM disagreement",
        status: "pass",
        detail: "7 point spread is within the 11 point tolerance.",
      },
    ],
    executionChecks: [
      {
        label: "Doctor",
        status: "pass",
        detail: "Live execution doctor is green for API auth and quote freshness.",
      },
      {
        label: "Balance",
        status: "pass",
        detail: "Wallet balance refresh completed before pre-trade validation.",
      },
      {
        label: "Order plan",
        status: "watch",
        detail: "Submitting a two-level limit ladder on the next rebalance cycle.",
      },
    ],
  },
  {
    id: "us-iran-framework-jun30",
    kind: "active",
    market: "Will the US-Iran meeting produce a written framework by June 30?",
    category: "Diplomacy / Energy",
    side: "NO",
    currentPrice: 61,
    fairProbability: 68,
    edge: 7,
    score: 74,
    currentExposure: 1600,
    targetExposure: 1600,
    proposedOrder: "No change",
    decision: "HOLD",
    riskStatus: "Watch",
    reason:
      "Still positive edge, but headline volatility and one cautious model keep this in hold rather than add-more.",
    lastUpdated: "2026-06-21T10:09:00+05:30",
    evidenceSummary: [
      "Negotiation calendar is unchanged, but no signed draft leaked in the last cycle.",
      "Three of five models remain confidently NO; two see a narrow path to a symbolic framework.",
      "Liquidity is stable, so the existing sizing does not need a defensive trim.",
    ],
    llmConsensus: {
      models: 5,
      agreementPct: 73,
      medianProbability: 68,
      spread: 10,
      dissentSummary:
        "Two models elevate odds because a short political memorandum could count as a written framework.",
    },
    sizing: {
      bankrollPct: 0,
      stakeUsd: 0,
      maxLossUsd: 0,
      reserveAfterTradeUsd: 18050,
      explanation:
        "Hold state keeps exposure flat until either the edge widens or the disagreement band tightens.",
    },
    stageAudit: buildStageAudit([
      ["pass", "Market scan matched the expected June 30 contract and fresh quotes."],
      ["pass", "Rules parser confirmed that only a written framework resolves YES."],
      ["pass", "Evidence sources remain within freshness SLA."],
      ["watch", "Consensus is positive but disagreement remains near the guardrail ceiling."],
      ["pass", "Exposure and reserve checks remain inside guardrails."],
      ["pass", "No rebalance delta is required for this cycle."],
      ["pass", "No order queued because hold logic won the decision stage."],
    ]),
    guardrailsChecked: [
      {
        label: "Max single trade",
        status: "pass",
        detail: "No new trade sized on this run.",
      },
      {
        label: "Max market exposure",
        status: "pass",
        detail: "Current exposure is below the market ceiling.",
      },
      {
        label: "Min edge",
        status: "pass",
        detail: "7 point edge stays above the 6 point minimum.",
      },
      {
        label: "Max LLM disagreement",
        status: "watch",
        detail: "10 point spread is close to the configured ceiling.",
      },
    ],
    executionChecks: [
      {
        label: "Doctor",
        status: "pass",
        detail: "Broker, quote, and order-book probes all passed.",
      },
      {
        label: "Balance",
        status: "pass",
        detail: "Balance snapshot is recent enough for a hold decision.",
      },
      {
        label: "Pre-trade",
        status: "pass",
        detail: "Skipped because no live order is required.",
      },
    ],
  },
  {
    id: "fed-cut-sep-2026",
    kind: "active",
    market: "Will the Fed cut rates before September 2026?",
    category: "Macro / Rates",
    side: "YES",
    currentPrice: 72,
    fairProbability: 65,
    edge: -7,
    score: 56,
    currentExposure: 1200,
    targetExposure: 700,
    proposedOrder: "Sell YES $500 @ 0.72 limit",
    decision: "TRIM",
    riskStatus: "Watch",
    reason:
      "Price outran updated consensus, so the engine wants to trim into strength while keeping a core position.",
    lastUpdated: "2026-06-21T10:02:00+05:30",
    evidenceSummary: [
      "Macro evidence bundle softened after stronger labor prints and a stickier inflation note.",
      "Consensus stayed constructive on eventual easing but not at the current market premium.",
      "Portfolio still benefits from keeping a smaller rates hedge on the book.",
    ],
    llmConsensus: {
      models: 4,
      agreementPct: 76,
      medianProbability: 65,
      spread: 8,
      dissentSummary:
        "One model still likes a higher near-term cut probability because growth momentum may fade quickly.",
    },
    sizing: {
      bankrollPct: 2,
      stakeUsd: -500,
      maxLossUsd: 0,
      reserveAfterTradeUsd: 18550,
      explanation:
        "Trimming realizes premium and brings the position back inside the target exposure band.",
    },
    stageAudit: buildStageAudit([
      ["pass", "Rates market contract scanned with current quote depth."],
      ["pass", "Rules and cutoff date checksum matched the stored spec."],
      ["pass", "Economic evidence pack refreshed across labor, CPI, and FOMC commentary."],
      ["pass", "Consensus median moved lower than the live price."],
      ["pass", "Trim sizing stayed inside turnover and reserve limits."],
      ["pass", "Portfolio delta recommends a partial de-risk, not a full exit."],
      ["watch", "Limit sell staged and waiting for spread compression."],
    ]),
    guardrailsChecked: [
      {
        label: "Max market exposure",
        status: "pass",
        detail: "Trim takes the position further below the per-market cap.",
      },
      {
        label: "Theme exposure",
        status: "watch",
        detail: "Macro theme is still concentrated even after the trim.",
      },
      {
        label: "Daily loss stop",
        status: "pass",
        detail: "Realized trim improves daily drawdown headroom.",
      },
      {
        label: "Limit orders only",
        status: "pass",
        detail: "Exit plan is staged as a passive sell order.",
      },
    ],
    executionChecks: [
      {
        label: "Doctor",
        status: "pass",
        detail: "Execution doctor sees healthy quote and order endpoints.",
      },
      {
        label: "Balance",
        status: "pass",
        detail: "No funding issue blocks a trim order.",
      },
      {
        label: "Venue pre-check",
        status: "watch",
        detail: "Sell order waits for one more spread check before release.",
      },
    ],
  },
  {
    id: "ceasefire-july-31",
    kind: "active",
    market: "Will the ceasefire hold through July 31?",
    category: "Geopolitics / Middle East",
    side: "YES",
    currentPrice: 57,
    fairProbability: 41,
    edge: -16,
    score: 31,
    currentExposure: 950,
    targetExposure: 0,
    proposedOrder: "Sell YES $950 @ 0.56 limit",
    decision: "EXIT",
    riskStatus: "Blocked",
    reason:
      "Evidence quality decayed, disagreement widened, and the live price now sits above fair value, so the engine wants a full exit.",
    lastUpdated: "2026-06-21T09:57:00+05:30",
    evidenceSummary: [
      "Two earlier sources aged out of the freshness window and conflict with the newest field reporting.",
      "Consensus flipped lower after models reweighted escalation risk.",
      "The position no longer earns capital under the minimum-edge rule.",
    ],
    llmConsensus: {
      models: 5,
      agreementPct: 58,
      medianProbability: 41,
      spread: 14,
      dissentSummary:
        "A minority of models still give diplomacy a narrow chance, but disagreement is now above tolerance.",
    },
    sizing: {
      bankrollPct: -3.8,
      stakeUsd: -950,
      maxLossUsd: 0,
      reserveAfterTradeUsd: 19500,
      explanation:
        "Full exit removes a deteriorating position and restores theme concentration headroom.",
    },
    stageAudit: buildStageAudit([
      ["pass", "Market scan and quote snapshot completed successfully."],
      ["pass", "Rules parser still matches the July 31 resolution text."],
      ["fail", "Evidence freshness failed because two required sources aged out."],
      ["fail", "Consensus spread breached the disagreement threshold."],
      ["fail", "Guardrail engine blocked any add or hold state at current prices."],
      ["pass", "Rebalance logic escalated directly to full exit."],
      ["watch", "Exit order is staged but held until the next liquidity sweep."],
    ]),
    guardrailsChecked: [
      {
        label: "Evidence requirement",
        status: "fail",
        detail: "Only one fresh shared source remains inside the freshness SLA.",
      },
      {
        label: "Max LLM disagreement",
        status: "fail",
        detail: "14 point spread is above the configured ceiling.",
      },
      {
        label: "Daily loss stop",
        status: "pass",
        detail: "Exit reduces drawdown risk before the stop is hit.",
      },
      {
        label: "Emergency stop status",
        status: "pass",
        detail: "Global emergency stop is clear, so an exit is allowed.",
      },
    ],
    executionChecks: [
      {
        label: "Doctor",
        status: "pass",
        detail: "Doctor allows exit-only orders under degraded evidence conditions.",
      },
      {
        label: "Balance",
        status: "pass",
        detail: "Position can be unwound without additional funding.",
      },
      {
        label: "Pre-trade",
        status: "watch",
        detail: "Order plan waits for one more book snapshot to avoid crossing spread.",
      },
    ],
  },
];

export const AUTO_LIVE_CANDIDATE_ROWS: AutoLiveRow[] = [
  {
    id: "solana-etf-sep30",
    kind: "candidate",
    market: "Will the SEC approve a spot Solana ETF by September 30?",
    category: "Crypto / Regulation",
    side: "YES",
    currentPrice: 38,
    fairProbability: 49,
    edge: 11,
    score: 81,
    currentExposure: 0,
    targetExposure: 1100,
    proposedOrder: "Buy YES $1,100 @ 0.39 limit",
    decision: "BUY_NEW",
    riskStatus: "Ready",
    reason:
      "Fresh regulatory evidence and strong model agreement push this above the buy-new edge and evidence thresholds.",
    lastUpdated: "2026-06-21T10:11:00+05:30",
    evidenceSummary: [
      "Shared evidence pack includes refreshed SEC commentary, issuer filings, and legal timeline notes.",
      "Model cluster tightened after the latest filing amendment improved approval odds.",
      "No existing crypto-theme slot conflicts with the proposed size.",
    ],
    llmConsensus: {
      models: 5,
      agreementPct: 86,
      medianProbability: 49,
      spread: 6,
      dissentSummary:
        "The only softer model still discounts timing risk rather than the approval path itself.",
    },
    sizing: {
      bankrollPct: 4.4,
      stakeUsd: 1100,
      maxLossUsd: 1100,
      reserveAfterTradeUsd: 16900,
      explanation:
        "Starter size lands below the single-trade cap while preserving reserve and theme headroom.",
    },
    stageAudit: buildStageAudit([
      ["pass", "Candidate surfaced in the latest Bullpen scan with healthy quote depth."],
      ["pass", "Resolution rules and approval deadline parsed cleanly."],
      ["pass", "Evidence pack refreshed with three fresh sources and no contradictions."],
      ["pass", "Consensus median cleared the buy-new threshold with low spread."],
      ["pass", "Sizing and reserve checks both passed."],
      ["pass", "Portfolio wants a new crypto-regulation slot at starter size."],
      ["watch", "Order ladder is ready but waits for operator-triggered live rebalance."],
    ]),
    guardrailsChecked: [
      {
        label: "Max single trade",
        status: "pass",
        detail: "$1,100 stays below the per-trade ceiling.",
      },
      {
        label: "Theme exposure",
        status: "pass",
        detail: "Crypto theme remains below the configured theme cap after entry.",
      },
      {
        label: "Cash reserve",
        status: "pass",
        detail: "Reserve floor remains intact after the proposed order.",
      },
      {
        label: "Evidence requirement",
        status: "pass",
        detail: "Three fresh shared sources were verified for this candidate.",
      },
    ],
    executionChecks: [
      {
        label: "Doctor",
        status: "pass",
        detail: "Live doctor is ready to route a passive limit ladder.",
      },
      {
        label: "Balance",
        status: "pass",
        detail: "Cash is available for a starter position.",
      },
      {
        label: "Pre-trade",
        status: "watch",
        detail: "Waiting for the next manual live rebalance trigger.",
      },
    ],
  },
  {
    id: "nvidia-july-31",
    kind: "candidate",
    market: "Will Nvidia close above $1,400 by July 31?",
    category: "Equities / Momentum",
    side: "YES",
    currentPrice: 54,
    fairProbability: 47,
    edge: -7,
    score: 42,
    currentExposure: 0,
    targetExposure: 0,
    proposedOrder: "No order",
    decision: "SKIP",
    riskStatus: "Blocked",
    reason:
      "Momentum is crowded, evidence is mixed, and consensus spread plus weak edge keep this out of the live queue.",
    lastUpdated: "2026-06-21T09:49:00+05:30",
    evidenceSummary: [
      "Price-action evidence is fresh, but the fundamental notes are split across valuation and earnings timing.",
      "Consensus never cleared the minimum-edge threshold for a fresh long.",
      "Skipping avoids using scarce momentum-theme exposure on a noisy setup.",
    ],
    llmConsensus: {
      models: 4,
      agreementPct: 61,
      medianProbability: 47,
      spread: 12,
      dissentSummary:
        "Two models still like breakout continuation, but the other cluster sees valuation resistance.",
    },
    sizing: {
      bankrollPct: 0,
      stakeUsd: 0,
      maxLossUsd: 0,
      reserveAfterTradeUsd: 18000,
      explanation:
        "No trade is sized because edge, disagreement, and theme-priority rules all fail the entry check.",
    },
    stageAudit: buildStageAudit([
      ["pass", "Candidate scanned normally and quote depth was available."],
      ["pass", "Resolution rules parsed without issue."],
      ["watch", "Evidence is fresh but mixed across catalysts and valuation."],
      ["fail", "Consensus spread exceeded the target range for a new entry."],
      ["fail", "Edge did not clear the minimum threshold after fees and slippage."],
      ["pass", "Portfolio correctly left target exposure at zero."],
      ["pass", "No live order staged because skip won the decision stage."],
    ]),
    guardrailsChecked: [
      {
        label: "Min edge",
        status: "fail",
        detail: "-7 points is below the configured minimum entry edge.",
      },
      {
        label: "Max LLM disagreement",
        status: "fail",
        detail: "12 point spread is above the tolerance band for new entries.",
      },
      {
        label: "Theme exposure",
        status: "pass",
        detail: "Skipping leaves momentum-theme capacity untouched.",
      },
      {
        label: "Limit orders only",
        status: "pass",
        detail: "No market order path is available in auto-live mode.",
      },
    ],
    executionChecks: [
      {
        label: "Doctor",
        status: "pass",
        detail: "Infrastructure is healthy, but the candidate is still blocked.",
      },
      {
        label: "Balance",
        status: "pass",
        detail: "Funding is available but intentionally unused.",
      },
      {
        label: "Pre-trade",
        status: "pass",
        detail: "Skipped because no order path is allowed.",
      },
    ],
  },
];
