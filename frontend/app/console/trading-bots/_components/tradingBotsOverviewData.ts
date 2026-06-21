import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Bot,
  BrainCircuit,
  Radar,
} from "lucide-react";

import type {
  BullpenActivePositionView,
  BullpenPositionsResponse,
} from "@/lib/bullpenPositions";
import type {
  TradingBotGuardrail,
  TradingBotSummary,
} from "@/lib/tradingBots";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveGuardrailCheck,
  BullpenAutoLiveSummaryResponse,
  PolymarketBotState,
  PolymarketSourceTradeDecision,
  TradingBotSummaryId,
} from "@/types/api";

export type TradingBotsOverviewDetails = {
  "bullpen-x-polymarket": PolymarketBotState | null;
  "polymarket-direct": PolymarketBotState | null;
  "bullpen-x-ai": BullpenPositionsResponse | null;
  "bullpen-ai-auto-live": BullpenAutoLiveSummaryResponse | null;
};

export type TradingBotCardRoleTone =
  | "copy"
  | "direct"
  | "analysis"
  | "automation";

export type TradingBotPresentation = {
  icon: LucideIcon;
  roleLabel: string;
  roleDetail: string;
  strategy: string;
  workflow: string;
  dataSources: string[];
  logsHref: string;
  decisionsFallback: string;
};

export type TradingBotDecisionItem = {
  id: string;
  title: string;
  detail: string;
  timestamp: string | null;
  tone: "neutral" | "positive" | "warning" | "critical";
};

export type TradingBotRiskStatus = {
  label: string;
  detail: string;
  tone: "neutral" | "positive" | "warning" | "critical";
  score: number;
};

export type TradingBotsPortfolioSummary = {
  totalMoneyInvested: number | null;
  totalCurrentValue: number | null;
  totalProfitLoss: number | null;
  totalReturnPct: number | null;
  totalActivePositions: number | null;
  totalTradesToday: number | null;
  botsRunning: number;
  botsPausedStopped: number;
  liveExposure: number | null;
  dryRunExposure: number | null;
  highestRiskBot: TradingBotSummary | null;
  highestRiskStatus: TradingBotRiskStatus | null;
  lastUpdated: string | null;
};

export type TradingBotsLiveWarning = {
  key: string;
  botId: TradingBotSummaryId;
  botName: string;
  label: string;
  detail: string;
  tone: "warning" | "critical";
};

const TRADING_BOT_PRESENTATION: Record<
  TradingBotSummaryId,
  TradingBotPresentation
> = {
  "bullpen-x-polymarket": {
    icon: Radar,
    roleLabel: "Copy-trading workflow",
    roleDetail: "Mirrors qualifying trader activity with copy-trade limits.",
    strategy:
      "Copy-trading style Bullpen/Polymarket bot that tracks selected traders or market activity and mirrors qualifying trades subject to copy-trade limits.",
    workflow:
      "Watches configured traders or live activity, applies copy-trade filters and exposure checks, then mirrors only qualifying positions into the managed bot account.",
    dataSources: [
      "Bullpen trader activity and tracked wallets",
      "Polymarket wallet balances, positions, and trade decisions",
      "Live doctor, discovery, and execution control signals",
    ],
    logsHref: "/console/polymarket-bot",
    decisionsFallback:
      "Recent mirrored trade decisions will appear here once live state is available.",
  },
  "polymarket-direct": {
    icon: ArrowLeftRight,
    roleLabel: "Direct market workflow",
    roleDetail: "Works directly with Polymarket account state and controls.",
    strategy:
      "Direct Polymarket workflow for market access, wallet/position checks, and direct trading/monitoring.",
    workflow:
      "Operates directly against Polymarket account state for monitoring, wallet checks, market discovery, and direct trading actions without the Bullpen copy-trade layer.",
    dataSources: [
      "Polymarket account balances and open positions",
      "Direct execution workflow controls and recent trade decisions",
      "Live doctor and discovery status",
    ],
    logsHref: "/console/polymarket-direct-bot",
    decisionsFallback:
      "Recent direct trade decisions will appear here once live state is available.",
  },
  "bullpen-x-ai": {
    icon: BrainCircuit,
    roleLabel: "Analysis and manual support",
    roleDetail: "Finds opportunities, but a human still decides whether to trade.",
    strategy:
      "Analysis-first LLM odds engine. Scans selected markets, runs multi-model probability estimates, compares LLM odds with market odds, and highlights potential opportunities. Not the automated live trader.",
    workflow:
      "Scans selected Bullpen markets, refreshes Polymarket odds, runs multi-model consensus, highlights edges, and supports manual review before any optional trade execution.",
    dataSources: [
      "Bullpen market scans and filters",
      "Polymarket market URLs, current odds, and wallet positions",
      "LLM consensus and evidence review outputs",
    ],
    logsHref: "/console/bullpen-ai",
    decisionsFallback:
      "A dedicated recent-decision feed is not exposed yet, so this overview shows active positions when available.",
  },
  "bullpen-ai-auto-live": {
    icon: Bot,
    roleLabel: "Automated execution engine",
    roleDetail: "Runs the full loop and can place live orders when all guardrails pass.",
    strategy:
      "Fully automated AI trading engine. It scans markets, parses rules, builds shared evidence, runs LLM consensus, applies portfolio guardrails, sizes positions, rebalances, and can execute live limit orders only when all guardrails pass.",
    workflow:
      "Runs the end-to-end autonomous pipeline: scan markets, parse rules, gather evidence, produce LLM consensus, score edges, apply portfolio guardrails, size positions, rebalance exposure, and optionally submit live limit orders.",
    dataSources: [
      "Polymarket market scans, rules parsing, and pricing",
      "Shared evidence packs and multi-model LLM consensus",
      "Portfolio guardrail checks, order plans, and recent auto-live runs",
    ],
    logsHref: "/console/trading-bots/bullpen-ai-auto-live",
    decisionsFallback:
      "Recent auto-live decisions will appear here once the execution summary is available.",
  },
};

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasText(value: string | null | undefined, phrases: string[]) {
  if (!value) return false;

  const normalized = normalizeText(value);
  return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
}

function exposureForBot(bot: TradingBotSummary) {
  const value = bot.currentValue ?? bot.moneyInvested;
  return value != null && Number.isFinite(value) ? value : null;
}

function isLiveExposureMode(mode: TradingBotSummary["mode"]) {
  return mode === "live-read" || mode === "live-trading";
}

function isDryRunExposureMode(mode: TradingBotSummary["mode"]) {
  return mode === "paper" || mode === "dry-run" || mode === "analysis-only";
}

function sumNumbers(values: Array<number | null | undefined>) {
  const finiteValues = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (finiteValues.length === 0) return null;

  return Number(
    finiteValues.reduce((total, value) => total + value, 0).toFixed(2),
  );
}

function toDecisionTone(
  value: string | null | undefined,
): TradingBotDecisionItem["tone"] {
  if (!value) return "neutral";

  const normalized = normalizeText(value);
  if (normalized.includes("fail") || normalized.includes("reject")) {
    return "critical";
  }
  if (
    normalized.includes("watch") ||
    normalized.includes("warn") ||
    normalized.includes("skip") ||
    normalized.includes("blocked")
  ) {
    return "warning";
  }
  if (
    normalized.includes("pass") ||
    normalized.includes("executed") ||
    normalized.includes("submit") ||
    normalized.includes("buy") ||
    normalized.includes("add")
  ) {
    return "positive";
  }
  return "neutral";
}

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";

  return `$${value.toFixed(2)}`;
}

function formatMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function titleCaseLabel(value: string) {
  return value
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function pushWarning(target: string[], value: string | null | undefined) {
  if (!value) return;

  const trimmed = value.trim();
  if (!trimmed) return;
  if (!target.includes(trimmed)) {
    target.push(trimmed);
  }
}

function summarizeInvalidWallets(state: PolymarketBotState) {
  const invalidWallets = state.live.source_status.manual_wallets_invalid;
  if (!invalidWallets.length) return null;

  return `Invalid tracked wallets: ${invalidWallets.slice(0, 2).join(", ")}${invalidWallets.length > 2 ? "..." : ""}`;
}

function summarizePendingConfirmations(state: PolymarketBotState) {
  const count = state.live.pending_confirmations.length;
  if (!count) return null;

  return `${count} live confirmation${count === 1 ? "" : "s"} pending review.`;
}

function findGuardrailMatches(
  checks: BullpenAutoLiveGuardrailCheck[],
  phrases: string[],
) {
  return checks.filter((check) => {
    const haystack = `${check.label} ${check.detail} ${check.value ?? ""}`;
    return hasText(haystack, phrases);
  });
}

function buildPolymarketDecisionItems(
  decisions: PolymarketSourceTradeDecision[],
): TradingBotDecisionItem[] {
  return decisions.slice(0, 5).map((decision) => ({
    id: decision.id,
    title: `${decision.side} ${decision.outcome} • ${decision.market_title}`,
    detail: `${titleCaseLabel(decision.status)} • ${formatMoney(decision.amount)} at ${formatPrice(decision.price)} • ${decision.trader_name}`,
    timestamp: decision.executed_at || decision.proposed_at,
    tone: toDecisionTone(decision.status),
  }));
}

function buildBullpenPositionItems(
  positions: BullpenActivePositionView[],
): TradingBotDecisionItem[] {
  return positions.slice(0, 5).map((position) => ({
    id: position.key,
    title: `Position • ${position.marketTitle}`,
    detail: `${position.outcome} • ${formatMoney(position.currentValue ?? position.costBasis)} current value • ${position.shares.toLocaleString("en-US", {
      maximumFractionDigits: 4,
    })} shares`,
    timestamp: position.closeTime,
    tone:
      position.unrealizedPnl != null && position.unrealizedPnl < 0
        ? "warning"
        : "neutral",
  }));
}

function buildAutoLiveDecisionItems(
  decisions: BullpenAutoLiveDecision[],
): TradingBotDecisionItem[] {
  return decisions.slice(0, 5).map((decision) => {
    const orderStatus = decision.order_plan?.status
      ? titleCaseLabel(decision.order_plan.status)
      : null;

    return {
      id: decision.id,
      title: `${titleCaseLabel(decision.decision)} ${decision.side} • ${decision.market_title}`,
      detail: `${decision.risk_status} • Edge ${decision.edge_pp.toFixed(1)}pp • Target ${formatMoney(decision.target_exposure_usd)}${orderStatus ? ` • Order ${orderStatus}` : ""}`,
      timestamp: decision.updated_at || decision.created_at,
      tone: toDecisionTone(
        decision.order_plan?.status ||
          decision.risk_status ||
          decision.disagreement_level,
      ),
    };
  });
}

export function getTradingBotPresentation(botId: TradingBotSummaryId) {
  return TRADING_BOT_PRESENTATION[botId];
}

export function getTradingBotTopGuardrails(guardrails: TradingBotGuardrail[]) {
  return guardrails.slice(0, 3);
}

export function getTradingBotWarnings(
  bot: TradingBotSummary,
  details: TradingBotsOverviewDetails,
) {
  const warnings: string[] = [];
  pushWarning(warnings, bot.note);

  if (bot.id === "bullpen-x-polymarket" || bot.id === "polymarket-direct") {
    const state = details[bot.id];
    if (!state) return warnings;

    if (state.live.emergency_stopped) {
      pushWarning(warnings, "Emergency stop is active.");
    }
    if (!state.live.doctor.ok) {
      pushWarning(warnings, state.live.doctor.message || "Doctor check failed.");
    }
    if (
      state.live.balance.status === "unavailable" ||
      state.live.balance.status === "error"
    ) {
      pushWarning(
        warnings,
        state.live.balance.message || "Balance is unavailable for this bot.",
      );
    }
    pushWarning(
      warnings,
      state.live.source_status.last_live_read_error || state.last_error,
    );
    pushWarning(warnings, summarizeInvalidWallets(state));
    pushWarning(warnings, summarizePendingConfirmations(state));
    return warnings;
  }

  if (bot.id === "bullpen-x-ai") {
    const positions = details[bot.id];
    if (!positions) return warnings;

    pushWarning(warnings, positions.error);
    const claimableCount = positions.summary?.claimableCount ?? 0;
    if (claimableCount > 0) {
      pushWarning(
        warnings,
        `${claimableCount} claimable position${claimableCount === 1 ? "" : "s"} still need manual follow-up.`,
      );
    }
    return warnings;
  }

  const summary = details[bot.id];
  if (!summary) return warnings;

  if (summary.state.emergency_stopped) {
    pushWarning(warnings, "Emergency stop is active.");
  }
  if (summary.state.live_armed) {
    pushWarning(warnings, "Live execution is armed.");
  }
  if (summary.state.doctor_status === "fail") {
    pushWarning(warnings, "Doctor checks are failing.");
  }
  if (summary.state.balance_status === "fail") {
    pushWarning(warnings, "Balance is unavailable.");
  }
  pushWarning(warnings, summary.state.last_error);
  pushWarning(warnings, summary.latest_run?.error_message ?? null);

  for (const check of summary.latest_guardrail_checks) {
    if (check.status === "fail" || check.status === "watch") {
      pushWarning(
        warnings,
        `${check.label}: ${check.detail}${check.value ? ` (${check.value})` : ""}`,
      );
    }
  }

  return warnings;
}

export function getTradingBotDecisionItems(
  bot: TradingBotSummary,
  details: TradingBotsOverviewDetails,
): TradingBotDecisionItem[] {
  if (bot.id === "bullpen-x-polymarket" || bot.id === "polymarket-direct") {
    return buildPolymarketDecisionItems(
      details[bot.id]?.live.recent_decisions ?? [],
    );
  }

  if (bot.id === "bullpen-x-ai") {
    return buildBullpenPositionItems(details[bot.id]?.positions ?? []);
  }

  return buildAutoLiveDecisionItems(details[bot.id]?.recent_decisions ?? []);
}

export function getTradingBotExecutionModeDetail(bot: TradingBotSummary) {
  if (bot.id === "bullpen-x-ai") {
    return "Analysis-only mode. It scans, scores, and supports manual trade decisions, but does not auto-execute live orders from this workflow.";
  }

  if (bot.id === "bullpen-ai-auto-live") {
    if (bot.mode === "live-trading") {
      return "Automated live execution mode. The engine can place or manage real limit orders after every portfolio, evidence, and risk guardrail passes.";
    }

    return "Automated dry-run mode. The full pipeline still scans, scores, sizes, and plans orders, but live submission stays disabled until the bot is armed.";
  }

  if (bot.mode === "live-trading") {
    return "Live-trading mode. The bot can act on real positions once doctor, balance, and execution guardrails stay green.";
  }

  if (bot.mode === "live-read") {
    return "Live-read mode. The bot reads live market and account state but keeps execution constrained by the current runtime controls.";
  }

  if (bot.mode === "paper") {
    return "Paper/mock mode. It remains available for workflow checks without additional live execution.";
  }

  return "This bot is currently in a non-live execution posture.";
}

export function getTradingBotRiskStatus(
  bot: TradingBotSummary,
  details: TradingBotsOverviewDetails,
): TradingBotRiskStatus {
  const warnings = getTradingBotWarnings(bot, details);
  const hasCriticalWarning = warnings.some((warning) =>
    hasText(warning, [
      "emergency stop",
      "doctor",
      "balance",
      "fail",
      "error",
      "blocked",
      "armed",
    ]),
  );

  if (bot.status === "error" || hasCriticalWarning) {
    return {
      label: "Blocked",
      detail:
        warnings[0] ||
        "One or more execution or health guardrails are failing for this bot.",
      tone: "critical",
      score: 100,
    };
  }

  if (bot.id === "bullpen-ai-auto-live" && bot.mode === "live-trading") {
    return {
      label: "Live",
      detail:
        "Automated execution is in a live posture and needs close guardrail monitoring.",
      tone: "warning",
      score: 85,
    };
  }

  if (warnings.length > 0 || bot.status === "paused") {
    return {
      label: "Watch",
      detail:
        warnings[0] ||
        "The bot is paused or has caution-level signals worth checking.",
      tone: "warning",
      score: 70,
    };
  }

  if (bot.id === "bullpen-x-ai") {
    return {
      label: "Manual",
      detail:
        "This workflow is decision support only, so portfolio risk depends on manual follow-through.",
      tone: "neutral",
      score: 45,
    };
  }

  if (bot.status === "not-configured") {
    return {
      label: "Setup",
      detail: "Configuration is incomplete, so the bot is not fully operational yet.",
      tone: "neutral",
      score: 40,
    };
  }

  if (bot.status === "stopped") {
    return {
      label: "Dormant",
      detail: "The bot is stopped and is not actively taking new actions right now.",
      tone: "neutral",
      score: 35,
    };
  }

  return {
    label: "Ready",
    detail: "Runtime status and current guardrails look healthy from the overview.",
    tone: "positive",
    score: 20,
  };
}

export function buildTradingBotsPortfolioSummary(
  bots: TradingBotSummary[],
  details: TradingBotsOverviewDetails,
  generatedAt: string | null,
): TradingBotsPortfolioSummary {
  const highestRiskEntry = bots
    .map((bot) => ({
      bot,
      risk: getTradingBotRiskStatus(bot, details),
    }))
    .sort((left, right) => right.risk.score - left.risk.score)[0];

  const totalMoneyInvested = sumNumbers(bots.map((bot) => bot.moneyInvested));
  const totalCurrentValue = sumNumbers(bots.map((bot) => bot.currentValue));
  const totalProfitLoss =
    sumNumbers(bots.map((bot) => bot.profitLoss)) ??
    (totalMoneyInvested != null && totalCurrentValue != null
      ? Number((totalCurrentValue - totalMoneyInvested).toFixed(2))
      : null);
  const totalReturnPct =
    totalMoneyInvested != null &&
    totalMoneyInvested > 0 &&
    totalProfitLoss != null
      ? Number(((totalProfitLoss / totalMoneyInvested) * 100).toFixed(2))
      : null;

  const liveExposure = sumNumbers(
    bots
      .filter((bot) => isLiveExposureMode(bot.mode))
      .map((bot) => exposureForBot(bot)),
  );
  const dryRunExposure = sumNumbers(
    bots
      .filter((bot) => isDryRunExposureMode(bot.mode))
      .map((bot) => exposureForBot(bot)),
  );

  return {
    totalMoneyInvested,
    totalCurrentValue,
    totalProfitLoss,
    totalReturnPct,
    totalActivePositions: sumNumbers(
      bots.map((bot) => bot.activePositionsCount ?? null),
    ),
    totalTradesToday: sumNumbers(bots.map((bot) => bot.tradesToday ?? null)),
    botsRunning: bots.filter((bot) => bot.status === "running").length,
    botsPausedStopped: bots.filter((bot) => bot.status !== "running").length,
    liveExposure,
    dryRunExposure,
    highestRiskBot: highestRiskEntry?.bot ?? null,
    highestRiskStatus: highestRiskEntry?.risk ?? null,
    lastUpdated: generatedAt,
  };
}

export function buildTradingBotsLiveWarnings(
  bots: TradingBotSummary[],
  details: TradingBotsOverviewDetails,
) {
  const warnings: TradingBotsLiveWarning[] = [];
  const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));

  const bullpenState = details["bullpen-x-polymarket"];
  if (bullpenState) {
    if (bullpenState.live.emergency_stopped) {
      warnings.push({
        key: "bullpen-emergency-stop",
        botId: "bullpen-x-polymarket",
        botName:
          botNameById.get("bullpen-x-polymarket") || "Bullpen x Polymarket",
        label: "Emergency stop active",
        detail: "Copy-trading execution is halted by the live emergency stop.",
        tone: "critical",
      });
    }
    if (!bullpenState.live.doctor.ok) {
      warnings.push({
        key: "bullpen-doctor-failed",
        botId: "bullpen-x-polymarket",
        botName:
          botNameById.get("bullpen-x-polymarket") || "Bullpen x Polymarket",
        label: "Doctor failed",
        detail: bullpenState.live.doctor.message || "Doctor checks failed.",
        tone: "critical",
      });
    }
    if (
      bullpenState.live.balance.status === "unavailable" ||
      bullpenState.live.balance.status === "error"
    ) {
      warnings.push({
        key: "bullpen-balance-unavailable",
        botId: "bullpen-x-polymarket",
        botName:
          botNameById.get("bullpen-x-polymarket") || "Bullpen x Polymarket",
        label: "Balance unavailable",
        detail:
          bullpenState.live.balance.message ||
          "Live balance data is unavailable for this bot.",
        tone: "critical",
      });
    }
    if (
      bullpenState.mode === "live-trading" &&
      bullpenState.live.enabled_by_env &&
      bullpenState.live.unlocked &&
      !bullpenState.live.emergency_stopped
    ) {
      warnings.push({
        key: "bullpen-live-armed",
        botId: "bullpen-x-polymarket",
        botName:
          botNameById.get("bullpen-x-polymarket") || "Bullpen x Polymarket",
        label: "Live execution armed",
        detail: "This copy-trading bot is currently unlocked for live execution.",
        tone: "warning",
      });
    }
  }

  const directState = details["polymarket-direct"];
  if (directState) {
    if (directState.live.emergency_stopped) {
      warnings.push({
        key: "direct-emergency-stop",
        botId: "polymarket-direct",
        botName: botNameById.get("polymarket-direct") || "Polymarket Direct",
        label: "Emergency stop active",
        detail: "Direct execution is halted by the live emergency stop.",
        tone: "critical",
      });
    }
    if (!directState.live.doctor.ok) {
      warnings.push({
        key: "direct-doctor-failed",
        botId: "polymarket-direct",
        botName: botNameById.get("polymarket-direct") || "Polymarket Direct",
        label: "Doctor failed",
        detail: directState.live.doctor.message || "Doctor checks failed.",
        tone: "critical",
      });
    }
    if (
      directState.live.balance.status === "unavailable" ||
      directState.live.balance.status === "error"
    ) {
      warnings.push({
        key: "direct-balance-unavailable",
        botId: "polymarket-direct",
        botName: botNameById.get("polymarket-direct") || "Polymarket Direct",
        label: "Balance unavailable",
        detail:
          directState.live.balance.message ||
          "Live balance data is unavailable for this bot.",
        tone: "critical",
      });
    }
    if (
      directState.mode === "live-trading" &&
      directState.live.enabled_by_env &&
      directState.live.unlocked &&
      !directState.live.emergency_stopped
    ) {
      warnings.push({
        key: "direct-live-armed",
        botId: "polymarket-direct",
        botName: botNameById.get("polymarket-direct") || "Polymarket Direct",
        label: "Live execution armed",
        detail: "This direct bot is currently unlocked for live execution.",
        tone: "warning",
      });
    }
  }

  const autoLive = details["bullpen-ai-auto-live"];
  if (autoLive) {
    const { state, latest_guardrail_checks: guardrailChecks } = autoLive;

    if (state.emergency_stopped) {
      warnings.push({
        key: "auto-live-emergency-stop",
        botId: "bullpen-ai-auto-live",
        botName:
          botNameById.get("bullpen-ai-auto-live") || "Bullpen AI Auto-Live",
        label: "Emergency stop active",
        detail: "The automated execution engine is emergency-stopped.",
        tone: "critical",
      });
    }
    if (state.doctor_status === "fail") {
      warnings.push({
        key: "auto-live-doctor-failed",
        botId: "bullpen-ai-auto-live",
        botName:
          botNameById.get("bullpen-ai-auto-live") || "Bullpen AI Auto-Live",
        label: "Doctor failed",
        detail:
          findGuardrailMatches(guardrailChecks, ["doctor"])[0]?.detail ||
          "Doctor guardrails are failing.",
        tone: "critical",
      });
    }
    if (state.balance_status === "fail") {
      warnings.push({
        key: "auto-live-balance-unavailable",
        botId: "bullpen-ai-auto-live",
        botName:
          botNameById.get("bullpen-ai-auto-live") || "Bullpen AI Auto-Live",
        label: "Balance unavailable",
        detail:
          findGuardrailMatches(guardrailChecks, ["balance"])[0]?.detail ||
          "Balance guardrails are failing.",
        tone: "critical",
      });
    }

    for (const check of findGuardrailMatches(guardrailChecks, [
      "daily loss",
      "weekly loss",
      "loss stop",
    ])) {
      if (check.status === "fail" || check.status === "watch") {
        warnings.push({
          key: `auto-live-loss-stop-${check.id}`,
          botId: "bullpen-ai-auto-live",
          botName:
            botNameById.get("bullpen-ai-auto-live") || "Bullpen AI Auto-Live",
          label: "Daily/weekly loss stop triggered",
          detail: `${check.label}: ${check.detail}`,
          tone: "critical",
        });
      }
    }

    for (const check of findGuardrailMatches(guardrailChecks, [
      "llm disagreement",
      "llm spread",
      "disagreement",
    ])) {
      if (check.status === "fail" || check.status === "watch") {
        warnings.push({
          key: `auto-live-llm-disagreement-${check.id}`,
          botId: "bullpen-ai-auto-live",
          botName:
            botNameById.get("bullpen-ai-auto-live") || "Bullpen AI Auto-Live",
          label: "High LLM disagreement",
          detail: `${check.label}: ${check.detail}`,
          tone: "warning",
        });
      }
    }

    if (state.live_armed) {
      warnings.push({
        key: "auto-live-live-armed",
        botId: "bullpen-ai-auto-live",
        botName:
          botNameById.get("bullpen-ai-auto-live") || "Bullpen AI Auto-Live",
        label: "Live execution armed",
        detail:
          "The automated execution engine is armed and can submit live limit orders.",
        tone: "warning",
      });
    }
  }

  return warnings;
}
