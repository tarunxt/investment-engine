"use client";

import type { BullpenAutoLiveSettings } from "@/types/api";

export type BullpenAiAutoLiveGuardrailTag =
  | "HARD BLOCK"
  | "SIZING MODIFIER"
  | "SCHEDULE";

export type BullpenAiAutoLiveGuardrailSectionId =
  | "capitalExposure"
  | "diversification"
  | "entryRules"
  | "llmEvidence"
  | "liquidityExecution"
  | "exitRebalance"
  | "circuitBreakers"
  | "scheduleAutomation";

type GuardrailFieldKind =
  | "currency"
  | "percent"
  | "points"
  | "ratio"
  | "integer"
  | "hours"
  | "minutes"
  | "seconds"
  | "boolean"
  | "enum";

type GuardrailOption = {
  label: string;
  value: string;
};

export type BullpenAiAutoLiveGuardrailField = {
  key: keyof BullpenAutoLiveSettings;
  sectionIds: BullpenAiAutoLiveGuardrailSectionId[];
  label: string;
  description: string;
  tag: BullpenAiAutoLiveGuardrailTag;
  canEnableLiveExecutionRisk: boolean;
  kind: GuardrailFieldKind;
  rangeLabel: string;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  step?: number;
  options?: GuardrailOption[];
};

export type BullpenAiAutoLiveGuardrailDraft = {
  [K in keyof BullpenAutoLiveSettings]: string | boolean;
};

export type BullpenAiAutoLiveGuardrailValidation = {
  settings: BullpenAutoLiveSettings | null;
  fieldErrors: Partial<Record<keyof BullpenAutoLiveSettings, string>>;
  formErrors: string[];
};

export const BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS: BullpenAutoLiveSettings = {
  strategy_profile: "guardrail_kelly",
  bankroll_usd: 100,
  bankroll_source: "manual",
  max_single_trade_pct_bankroll: 2,
  max_single_market_pct_bankroll: 6,
  max_theme_exposure_pct_bankroll: 20,
  max_open_exposure_pct_bankroll: 60,
  min_cash_reserve_pct_bankroll: 40,
  min_order_usd: 1,
  max_order_usd: 25,
  console_order_usd: 5,
  console_min_market_odds: 5,
  min_liquidity_usd: 1000,
  min_independent_active_markets: 10,
  target_active_markets: 15,
  max_active_markets: 25,
  max_new_markets_per_rebalance: 3,
  min_edge_pp: 15,
  min_score: 8,
  kelly_fraction: 0.25,
  initial_tranche_pct: 50,
  add_more_threshold_pct: 25,
  max_llm_spread_pp: 30,
  half_size_llm_spread_pp: 15,
  min_evidence_status: "Moderate",
  min_confidence: "Medium",
  adjudication_required_blocks_trade: true,
  limit_orders_only: true,
  max_bid_ask_spread_cents: 5,
  max_slippage_cents: 2,
  trade_cooldown_hours_per_market: 2,
  max_reprice_attempts: 2,
  stage3_exit_poll_timeout_seconds: 30,
  stage3_exit_poll_interval_seconds: 3,
  bullpen_economic_dust_threshold_usd: 0.01,
  stage3_rpc_retry_attempts: 1,
  stage3_rpc_retry_initial_delay_seconds: 1,
  stage3_rpc_retry_max_delay_seconds: 30,
  stage3_rpc_retry_max_total_wait_seconds: 120,
  stage3_capacity_override: false,
  exit_edge_pp: 3,
  trim_edge_pp: 8,
  rebalance_interval_minutes: 240,
  no_new_trade_under_hours_to_deadline: 6,
  half_size_under_hours_to_deadline: 48,
  max_rebalance_churn_pct_bankroll: 10,
  max_daily_loss_pct_bankroll: 3,
  max_weekly_loss_pct_bankroll: 8,
  pause_after_consecutive_failed_orders: 2,
  pause_if_balance_unavailable: true,
  pause_if_doctor_fails: true,
  pause_if_llm_provider_error_rate_high: true,
  emergency_stop: false,
  active_price_refresh_seconds: 60,
  candidate_price_refresh_minutes: 5,
  new_scan_interval_minutes: 60,
  llm_rerun_interval_minutes: 240,
  max_llm_candidates_per_run: 100,
  console_llm_targets: [{ provider: "deepseek", model: "deepseek-v4-flash" }],
  llm_execution_mode: "chunked_parallel",
  llm_events_per_prompt: 20,
  console_llm_prompt_template: null,
  auto_live_enabled: false,
  dry_run: true,
  require_manual_confirmation: true,
  allow_live_execution: false,
};

export const BULLPEN_AI_AUTO_LIVE_GUARDRAIL_SECTIONS: {
  id: BullpenAiAutoLiveGuardrailSectionId;
  title: string;
  description: string;
}[] = [
  {
    id: "capitalExposure",
    title: "Capital & Exposure",
    description:
      "Control bankroll sizing, reserve protection, and how much capital any one trade, market, or theme can consume.",
  },
  {
    id: "diversification",
    title: "Diversification",
    description:
      "Define the number of independent markets the bot should spread across before concentration becomes a concern.",
  },
  {
    id: "entryRules",
    title: "Entry Rules",
    description:
      "Set the minimum edge, score, and tranche rules required before the bot is allowed to initiate or add to a position.",
  },
  {
    id: "llmEvidence",
    title: "LLM & Evidence",
    description:
      "Require enough agreement, confidence, and evidence quality before any automated trade can move forward.",
  },
  {
    id: "liquidityExecution",
    title: "Liquidity & Execution",
    description:
      "Limit execution to healthy order books, controlled spreads, and predictable repricing behavior.",
  },
  {
    id: "exitRebalance",
    title: "Exit & Rebalance",
    description:
      "Decide when the bot trims, exits, or slows down near a deadline, and how much churn is acceptable in one rebalance.",
  },
  {
    id: "circuitBreakers",
    title: "Circuit Breakers",
    description:
      "Hard-stop the strategy when drawdowns, repeated failures, or provider health issues make automation unsafe.",
  },
  {
    id: "scheduleAutomation",
    title: "Schedule & Automation",
    description:
      "Set scan cadence, rebalance timing, and the high-level switches that determine whether the bot can stay analysis-only or operate live.",
  },
];

const evidenceOptions: GuardrailOption[] = [
  { label: "Low", value: "Low" },
  { label: "Moderate", value: "Moderate" },
  { label: "Strong", value: "Strong" },
];

const confidenceOptions: GuardrailOption[] = [
  { label: "Low", value: "Low" },
  { label: "Medium", value: "Medium" },
  { label: "High", value: "High" },
];

const bankrollSourceOptions: GuardrailOption[] = [
  { label: "Manual", value: "manual" },
];

export const BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS: BullpenAiAutoLiveGuardrailField[] = [
  {
    key: "bankroll_usd",
    sectionIds: ["capitalExposure"],
    label: "Bankroll (USD)",
    description: "Total bankroll the bot is allowed to size from before any reserve rules are applied.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "currency",
    rangeLabel: "> $0",
    min: 0,
    minExclusive: true,
    step: 1,
  },
  {
    key: "bankroll_source",
    sectionIds: ["capitalExposure"],
    label: "Bankroll Source",
    description: "Declares how the bankroll figure is sourced. The current backend only supports a manual bankroll source.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "enum",
    rangeLabel: "Manual only",
    options: bankrollSourceOptions,
  },
  {
    key: "max_single_trade_pct_bankroll",
    sectionIds: ["capitalExposure"],
    label: "Max Single Trade (% Bankroll)",
    description: "Caps the bankroll share a single order can allocate in one shot.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "> 0% and <= 100%",
    min: 0,
    minExclusive: true,
    max: 100,
    step: 0.1,
  },
  {
    key: "max_single_market_pct_bankroll",
    sectionIds: ["capitalExposure"],
    label: "Max Single Market (% Bankroll)",
    description: "Limits total capital exposure to one market across all tranches and rebalance actions.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "> 0% and <= 100%",
    min: 0,
    minExclusive: true,
    max: 100,
    step: 0.1,
  },
  {
    key: "max_theme_exposure_pct_bankroll",
    sectionIds: ["capitalExposure"],
    label: "Max Theme Exposure (% Bankroll)",
    description: "Prevents multiple related markets from turning into one oversized theme bet.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "> 0% and <= 100%",
    min: 0,
    minExclusive: true,
    max: 100,
    step: 0.1,
  },
  {
    key: "max_open_exposure_pct_bankroll",
    sectionIds: ["capitalExposure"],
    label: "Max Open Exposure (% Bankroll)",
    description: "Puts a ceiling on how much of the bankroll can be committed across all open positions.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "> 0% and <= 100%",
    min: 0,
    minExclusive: true,
    max: 100,
    step: 0.1,
  },
  {
    key: "min_cash_reserve_pct_bankroll",
    sectionIds: ["capitalExposure"],
    label: "Min Cash Reserve (% Bankroll)",
    description: "Reserves a minimum cash buffer so the bot cannot fully deploy the bankroll.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "0% to 100%",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    key: "min_order_usd",
    sectionIds: ["capitalExposure"],
    label: "Min Order (USD)",
    description: "Blocks tiny orders that add operational noise without meaningful exposure.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "currency",
    rangeLabel: "> $0",
    min: 0,
    minExclusive: true,
    step: 0.01,
  },
  {
    key: "max_order_usd",
    sectionIds: ["capitalExposure"],
    label: "Max Order (USD)",
    description: "Defines the absolute dollar cap for any one submitted order.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "currency",
    rangeLabel: "> $0",
    min: 0,
    minExclusive: true,
    step: 0.01,
  },
  {
    key: "min_liquidity_usd",
    sectionIds: ["liquidityExecution"],
    label: "Min Liquidity (USD)",
    description: "Blocks low-liquidity markets during candidate scan before evidence and sizing are allowed to proceed.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "currency",
    rangeLabel: ">= $0",
    min: 0,
    step: 1,
  },
  {
    key: "min_independent_active_markets",
    sectionIds: ["diversification"],
    label: "Min Independent Active Markets",
    description: "Minimum number of independent markets preferred before the book is considered well diversified.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: ">= 1",
    min: 1,
    step: 1,
  },
  {
    key: "target_active_markets",
    sectionIds: ["diversification"],
    label: "Target Active Markets",
    description: "The working diversification target the bot tries to maintain across active ideas.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: ">= 1",
    min: 1,
    step: 1,
  },
  {
    key: "max_active_markets",
    sectionIds: ["diversification"],
    label: "Max Active Markets",
    description: "Stops the bot from opening so many markets that supervision and execution quality degrade.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: ">= 1",
    min: 1,
    step: 1,
  },
  {
    key: "max_new_markets_per_rebalance",
    sectionIds: ["diversification"],
    label: "Max New Markets Per Rebalance",
    description: "Limits how many brand-new markets can be introduced in one rebalance cycle.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: ">= 0",
    min: 0,
    step: 1,
  },
  {
    key: "min_edge_pp",
    sectionIds: ["entryRules"],
    label: "Min Edge (pp)",
    description: "Minimum edge over market price required before the bot can enter a trade.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 pp",
    min: 0,
    step: 0.1,
  },
  {
    key: "min_score",
    sectionIds: ["entryRules"],
    label: "Min Score",
    description: "Minimum composite score the candidate must reach before the bot can act on it.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "ratio",
    rangeLabel: ">= 0",
    min: 0,
    step: 0.1,
  },
  {
    key: "kelly_fraction",
    sectionIds: ["entryRules"],
    label: "Kelly Fraction",
    description: "Scales position size relative to the raw Kelly estimate to keep sizing conservative.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "ratio",
    rangeLabel: "0 to 1",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "initial_tranche_pct",
    sectionIds: ["entryRules"],
    label: "Initial Tranche (%)",
    description: "Portion of the target position the bot may open on the first fill.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "> 0% and <= 100%",
    min: 0,
    minExclusive: true,
    max: 100,
    step: 0.1,
  },
  {
    key: "add_more_threshold_pct",
    sectionIds: ["entryRules"],
    label: "Add More Threshold (%)",
    description: "Defines how far the signal must improve before the bot can size further into an existing idea.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "0% to 100%",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    key: "max_llm_spread_pp",
    sectionIds: ["llmEvidence"],
    label: "Max LLM Spread (pp)",
    description: "Hard cap on how much model disagreement is tolerated before the trade is blocked.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 pp",
    min: 0,
    step: 0.1,
  },
  {
    key: "half_size_llm_spread_pp",
    sectionIds: ["llmEvidence"],
    label: "Half-Size LLM Spread (pp)",
    description: "Disagreement threshold where the bot cuts position size instead of fully blocking the trade.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 pp",
    min: 0,
    step: 0.1,
  },
  {
    key: "min_evidence_status",
    sectionIds: ["llmEvidence"],
    label: "Min Evidence Status",
    description: "Minimum evidence quality required before automation can rely on the research package.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "enum",
    rangeLabel: "Low, Moderate, or Strong",
    options: evidenceOptions,
  },
  {
    key: "min_confidence",
    sectionIds: ["llmEvidence"],
    label: "Min Confidence",
    description: "Minimum model confidence required for a trade to stay eligible after evidence checks.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "enum",
    rangeLabel: "Low, Medium, or High",
    options: confidenceOptions,
  },
  {
    key: "adjudication_required_blocks_trade",
    sectionIds: ["llmEvidence"],
    label: "Adjudication Required Blocks Trade",
    description: "When enabled, markets that still need adjudication certainty are blocked from trading.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "limit_orders_only",
    sectionIds: ["liquidityExecution"],
    label: "Limit Orders Only",
    description: "Keeps all live execution constrained to limit orders. Turning this off blocks live execution.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "max_bid_ask_spread_cents",
    sectionIds: ["liquidityExecution"],
    label: "Max Bid/Ask Spread (cents)",
    description: "Maximum quoted spread tolerated before the market is considered too wide to trade.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 cents",
    min: 0,
    step: 0.1,
  },
  {
    key: "max_slippage_cents",
    sectionIds: ["liquidityExecution"],
    label: "Max Slippage (cents)",
    description: "Caps how far an execution can drift from the intended limit price.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 cents",
    min: 0,
    step: 0.1,
  },
  {
    key: "trade_cooldown_hours_per_market",
    sectionIds: ["liquidityExecution"],
    label: "Trade Cooldown Per Market (hours)",
    description: "Wait time before the bot can touch the same market again after a completed action.",
    tag: "SCHEDULE",
    canEnableLiveExecutionRisk: false,
    kind: "hours",
    rangeLabel: ">= 0 hours",
    min: 0,
    step: 0.1,
  },
  {
    key: "max_reprice_attempts",
    sectionIds: ["liquidityExecution"],
    label: "Max Reprice Attempts",
    description: "Maximum number of times the bot may reprice a limit order before giving up.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: ">= 0",
    min: 0,
    step: 1,
  },
  {
    key: "stage3_rpc_retry_attempts",
    sectionIds: ["exitRebalance"],
    label: "Stage 3 RPC Retry Attempts",
    description: "How many additional Bullpen RPC write attempts Stage 3 may make after a rate-limit response.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: "0 to 20",
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: "stage3_rpc_retry_initial_delay_seconds",
    sectionIds: ["exitRebalance"],
    label: "Stage 3 RPC Initial Retry Delay",
    description: "Initial fallback delay before retrying a rate-limited Bullpen write.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "seconds",
    rangeLabel: "0 to 300 seconds",
    min: 0,
    max: 300,
    step: 0.1,
  },
  {
    key: "stage3_rpc_retry_max_delay_seconds",
    sectionIds: ["exitRebalance"],
    label: "Stage 3 RPC Max Retry Delay",
    description: "Caps exponential fallback delay; Bullpen Retry-After remains authoritative within the total wait budget.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "seconds",
    rangeLabel: "0 to 900 seconds",
    min: 0,
    max: 900,
    step: 0.1,
  },
  {
    key: "stage3_rpc_retry_max_total_wait_seconds",
    sectionIds: ["exitRebalance"],
    label: "Stage 3 RPC Max Total Wait",
    description: "Maximum cumulative wait before a rate-limited exit is marked permanently failed and made resumable.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "seconds",
    rangeLabel: "0 to 3600 seconds",
    min: 0,
    max: 3600,
    step: 1,
  },
  {
    key: "stage3_capacity_override",
    sectionIds: ["exitRebalance"],
    label: "Stage 3 Capacity Override",
    description: "DANGEROUS: explicit operator action bypasses only the slot-capacity gate. Cash, duplicate-market, price, slippage, exposure, cooldown, and live-execution guardrails still apply.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "Off by default",
  },
  {
    key: "exit_edge_pp",
    sectionIds: ["exitRebalance"],
    label: "Exit Edge (pp)",
    description: "Signal level where the bot should exit because the remaining edge is no longer attractive.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 pp",
    min: 0,
    step: 0.1,
  },
  {
    key: "trim_edge_pp",
    sectionIds: ["exitRebalance"],
    label: "Trim Edge (pp)",
    description: "Signal level where the bot should reduce size instead of fully exiting the position.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "points",
    rangeLabel: ">= 0 pp",
    min: 0,
    step: 0.1,
  },
  {
    key: "rebalance_interval_minutes",
    sectionIds: ["exitRebalance", "scheduleAutomation"],
    label: "Rebalance Interval (minutes)",
    description: "How frequently the bot is allowed to rebalance active positions and target deltas.",
    tag: "SCHEDULE",
    canEnableLiveExecutionRisk: false,
    kind: "minutes",
    rangeLabel: ">= 1 minute",
    min: 1,
    step: 1,
  },
  {
    key: "no_new_trade_under_hours_to_deadline",
    sectionIds: ["exitRebalance"],
    label: "No New Trade Under Hours To Deadline",
    description: "Blocks brand-new entries once the market is too close to deadline for safe automation.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "hours",
    rangeLabel: ">= 0 hours",
    min: 0,
    step: 0.1,
  },
  {
    key: "half_size_under_hours_to_deadline",
    sectionIds: ["exitRebalance"],
    label: "Half-Size Under Hours To Deadline",
    description: "Cuts target size when the deadline is approaching, even if the trade stays eligible.",
    tag: "SIZING MODIFIER",
    canEnableLiveExecutionRisk: false,
    kind: "hours",
    rangeLabel: ">= 0 hours",
    min: 0,
    step: 0.1,
  },
  {
    key: "max_rebalance_churn_pct_bankroll",
    sectionIds: ["exitRebalance"],
    label: "Max Rebalance Churn (% Bankroll)",
    description: "Caps how much bankroll can be turned over in a single rebalance window.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "0% to 100%",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    key: "max_daily_loss_pct_bankroll",
    sectionIds: ["circuitBreakers"],
    label: "Max Daily Loss (% Bankroll)",
    description: "Stops further trading for the day when losses breach this bankroll threshold.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "0% to 100%",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    key: "max_weekly_loss_pct_bankroll",
    sectionIds: ["circuitBreakers"],
    label: "Max Weekly Loss (% Bankroll)",
    description: "Applies a wider rolling drawdown cap so the bot cannot keep compounding losses over the week.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "percent",
    rangeLabel: "0% to 100%",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    key: "pause_after_consecutive_failed_orders",
    sectionIds: ["circuitBreakers"],
    label: "Pause After Consecutive Failed Orders",
    description: "Automatically pauses automation after too many back-to-back order failures.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "integer",
    rangeLabel: ">= 0",
    min: 0,
    step: 1,
  },
  {
    key: "pause_if_balance_unavailable",
    sectionIds: ["circuitBreakers"],
    label: "Pause If Balance Unavailable",
    description: "Blocks automation when wallet balance cannot be refreshed with confidence.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "pause_if_doctor_fails",
    sectionIds: ["circuitBreakers"],
    label: "Pause If Doctor Fails",
    description: "Pauses the bot when the execution doctor reports unhealthy infrastructure or auth checks.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "pause_if_llm_provider_error_rate_high",
    sectionIds: ["circuitBreakers"],
    label: "Pause If LLM Provider Error Rate High",
    description: "Stops automation when model-provider instability makes consensus inputs unreliable.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: false,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "emergency_stop",
    sectionIds: ["circuitBreakers"],
    label: "Emergency Stop",
    description: "Immediate hard stop for all new automation runs and live execution attempts.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "active_price_refresh_seconds",
    sectionIds: ["scheduleAutomation"],
    label: "Active Price Refresh (seconds)",
    description: "How often active position prices can be refreshed while the bot is running.",
    tag: "SCHEDULE",
    canEnableLiveExecutionRisk: false,
    kind: "seconds",
    rangeLabel: ">= 5 seconds",
    min: 5,
    step: 1,
  },
  {
    key: "candidate_price_refresh_minutes",
    sectionIds: ["scheduleAutomation"],
    label: "Candidate Price Refresh (minutes)",
    description: "How often candidate market prices are refreshed before they become active positions.",
    tag: "SCHEDULE",
    canEnableLiveExecutionRisk: false,
    kind: "minutes",
    rangeLabel: ">= 1 minute",
    min: 1,
    step: 1,
  },
  {
    key: "new_scan_interval_minutes",
    sectionIds: ["scheduleAutomation"],
    label: "New Scan Interval (minutes)",
    description: "Cadence for discovering new markets and refreshing the candidate set.",
    tag: "SCHEDULE",
    canEnableLiveExecutionRisk: false,
    kind: "minutes",
    rangeLabel: ">= 1 minute",
    min: 1,
    step: 1,
  },
  {
    key: "llm_rerun_interval_minutes",
    sectionIds: ["scheduleAutomation"],
    label: "LLM Rerun Interval (minutes)",
    description: "How often the shared evidence and consensus pipeline is allowed to rerun.",
    tag: "SCHEDULE",
    canEnableLiveExecutionRisk: false,
    kind: "minutes",
    rangeLabel: ">= 1 minute",
    min: 1,
    step: 1,
  },
  {
    key: "auto_live_enabled",
    sectionIds: ["scheduleAutomation"],
    label: "Auto-Live Enabled",
    description: "Master switch that allows the automation engine to schedule and run the bot at all.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "dry_run",
    sectionIds: ["scheduleAutomation"],
    label: "Dry Run",
    description: "Keeps the full pipeline active while blocking live order submission.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "require_manual_confirmation",
    sectionIds: ["scheduleAutomation"],
    label: "Require Manual Confirmation",
    description: "Adds a human confirmation gate before live orders can route even when live execution is otherwise enabled.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
  {
    key: "allow_live_execution",
    sectionIds: ["scheduleAutomation"],
    label: "Allow Live Execution",
    description: "Enables the live execution path. This is one of the highest-risk switches in the entire bot.",
    tag: "HARD BLOCK",
    canEnableLiveExecutionRisk: true,
    kind: "boolean",
    rangeLabel: "On or Off",
  },
];

const fieldByKey = new Map(
  BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS.map((field) => [field.key, field]),
);

function trimTrailingZeros(value: number) {
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

export function getBullpenAiAutoLiveGuardrailField(
  key: keyof BullpenAutoLiveSettings,
) {
  return fieldByKey.get(key);
}

export function formatBullpenAiAutoLiveGuardrailValue(
  key: keyof BullpenAutoLiveSettings,
  value: BullpenAutoLiveSettings[keyof BullpenAutoLiveSettings],
) {
  const field = getBullpenAiAutoLiveGuardrailField(key);
  if (!field) {
    return String(value);
  }

  switch (field.kind) {
    case "currency":
      return formatCurrency(Number(value));
    case "percent":
      return `${trimTrailingZeros(Number(value))}%`;
    case "points":
      return `${trimTrailingZeros(Number(value))} pp`;
    case "ratio":
      return trimTrailingZeros(Number(value));
    case "integer":
      return new Intl.NumberFormat("en-US").format(Number(value));
    case "hours":
      return `${trimTrailingZeros(Number(value))}h`;
    case "minutes":
      return `${trimTrailingZeros(Number(value))}m`;
    case "seconds":
      return `${trimTrailingZeros(Number(value))}s`;
    case "boolean":
      return value ? "Enabled" : "Disabled";
    case "enum":
    default:
      return String(value);
  }
}

export function bullpenAiAutoLiveSettingsToDraft(
  settings: BullpenAutoLiveSettings,
): BullpenAiAutoLiveGuardrailDraft {
  const draft = {} as BullpenAiAutoLiveGuardrailDraft;
  draft.strategy_profile = settings.strategy_profile;

  for (const field of BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS) {
    const value = settings[field.key];
    draft[field.key] =
      field.kind === "boolean" ? Boolean(value) : String(value ?? "");
  }

  return draft;
}

export function buildBullpenAiAutoLiveSafeDefaultDraft() {
  return bullpenAiAutoLiveSettingsToDraft(BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS);
}

export function serializeBullpenAiAutoLiveGuardrails(
  settings: BullpenAutoLiveSettings,
) {
  return JSON.stringify(settings, null, 2);
}

function addFieldError(
  errors: Partial<Record<keyof BullpenAutoLiveSettings, string>>,
  key: keyof BullpenAutoLiveSettings,
  message: string,
) {
  if (!errors[key]) {
    errors[key] = message;
  }
}

export function validateBullpenAiAutoLiveGuardrailDraft(
  draft: BullpenAiAutoLiveGuardrailDraft,
): BullpenAiAutoLiveGuardrailValidation {
  const fieldErrors: Partial<Record<keyof BullpenAutoLiveSettings, string>> = {};
  const settings = {
    ...BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
    strategy_profile:
      draft.strategy_profile === "bullpen_console_top10"
        ? "bullpen_console_top10"
        : "guardrail_kelly",
  } as BullpenAutoLiveSettings;

  for (const field of BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS) {
    const rawValue = draft[field.key];

    if (field.kind === "boolean") {
      settings[field.key] = Boolean(rawValue) as never;
      continue;
    }

    if (field.kind === "enum") {
      const nextValue = String(rawValue ?? "").trim();
      if (!nextValue) {
        addFieldError(fieldErrors, field.key, "Select a value.");
        continue;
      }
      if (
        field.options &&
        !field.options.some((option) => option.value === nextValue)
      ) {
        addFieldError(fieldErrors, field.key, "Select a supported value.");
        continue;
      }
      settings[field.key] = nextValue as never;
      continue;
    }

    const textValue = String(rawValue ?? "").trim();
    if (!textValue) {
      addFieldError(fieldErrors, field.key, "Enter a value.");
      continue;
    }

    const numericValue = Number(textValue);
    if (!Number.isFinite(numericValue)) {
      addFieldError(fieldErrors, field.key, "Enter a valid number.");
      continue;
    }

    if (field.kind === "integer" && !Number.isInteger(numericValue)) {
      addFieldError(fieldErrors, field.key, "Enter a whole number.");
      continue;
    }

    if (typeof field.min === "number") {
      const tooLow = field.minExclusive
        ? numericValue <= field.min
        : numericValue < field.min;
      if (tooLow) {
        addFieldError(fieldErrors, field.key, `Allowed range: ${field.rangeLabel}.`);
        continue;
      }
    }

    if (typeof field.max === "number" && numericValue > field.max) {
      addFieldError(fieldErrors, field.key, `Allowed range: ${field.rangeLabel}.`);
      continue;
    }

    settings[field.key] = numericValue as never;
  }

  if (Object.keys(fieldErrors).length === 0) {
    if (
      settings.max_single_trade_pct_bankroll >
      settings.max_single_market_pct_bankroll
    ) {
      addFieldError(
        fieldErrors,
        "max_single_trade_pct_bankroll",
        "Single-trade cap must be less than or equal to single-market cap.",
      );
      addFieldError(
        fieldErrors,
        "max_single_market_pct_bankroll",
        "Single-market cap must be greater than or equal to single-trade cap.",
      );
    }

    if (
      settings.max_open_exposure_pct_bankroll +
        settings.min_cash_reserve_pct_bankroll >
      100
    ) {
      addFieldError(
        fieldErrors,
        "max_open_exposure_pct_bankroll",
        "Open exposure plus cash reserve must stay at or below 100% of bankroll.",
      );
      addFieldError(
        fieldErrors,
        "min_cash_reserve_pct_bankroll",
        "Cash reserve plus open exposure must stay at or below 100% of bankroll.",
      );
    }

    if (settings.min_edge_pp < settings.exit_edge_pp) {
      addFieldError(
        fieldErrors,
        "min_edge_pp",
        "Entry edge must be greater than or equal to exit edge.",
      );
      addFieldError(
        fieldErrors,
        "exit_edge_pp",
        "Exit edge cannot exceed the minimum entry edge.",
      );
    }

    if (settings.trim_edge_pp < settings.exit_edge_pp) {
      addFieldError(
        fieldErrors,
        "trim_edge_pp",
        "Trim edge must be greater than or equal to exit edge.",
      );
      addFieldError(
        fieldErrors,
        "exit_edge_pp",
        "Exit edge cannot exceed the trim edge.",
      );
    }

    if (settings.max_active_markets < settings.target_active_markets) {
      addFieldError(
        fieldErrors,
        "max_active_markets",
        "Max active markets must be greater than or equal to target active markets.",
      );
      addFieldError(
        fieldErrors,
        "target_active_markets",
        "Target active markets cannot exceed max active markets.",
      );
    }

    if (
      settings.target_active_markets <
      settings.min_independent_active_markets
    ) {
      addFieldError(
        fieldErrors,
        "target_active_markets",
        "Target active markets must be greater than or equal to the minimum independent market count.",
      );
      addFieldError(
        fieldErrors,
        "min_independent_active_markets",
        "Minimum independent market count cannot exceed the target market count.",
      );
    }

    if (settings.max_order_usd < settings.min_order_usd) {
      addFieldError(
        fieldErrors,
        "max_order_usd",
        "Max order must be greater than or equal to min order.",
      );
      addFieldError(
        fieldErrors,
        "min_order_usd",
        "Min order cannot exceed max order.",
      );
    }

    if (settings.allow_live_execution && !settings.limit_orders_only) {
      addFieldError(
        fieldErrors,
        "allow_live_execution",
        "Live execution requires limit orders only to stay enabled.",
      );
      addFieldError(
        fieldErrors,
        "limit_orders_only",
        "Turning off limit orders only blocks live execution.",
      );
    }

    if (settings.half_size_llm_spread_pp > settings.max_llm_spread_pp) {
      addFieldError(
        fieldErrors,
        "half_size_llm_spread_pp",
        "Half-size disagreement spread cannot exceed max LLM spread.",
      );
      addFieldError(
        fieldErrors,
        "max_llm_spread_pp",
        "Max LLM spread must be greater than or equal to half-size disagreement spread.",
      );
    }
  }

  return {
    settings:
      Object.keys(fieldErrors).length === 0 ? settings : null,
    fieldErrors,
    formErrors: [],
  };
}
