import type { BullpenPositionsResponse } from "@/lib/bullpenPositions";
import { URLs } from "@/lib/urls";
import type {
  BullpenAutoLiveSummaryResponse,
  PolymarketBotState,
  TradingBotGuardrail as ApiTradingBotGuardrail,
  TradingBotGuardrailTone,
  TradingBotMode,
  TradingBotStatus,
  TradingBotSummary as ApiTradingBotOverviewCard,
  TradingBotSummaryCard as ApiTradingBotSummaryCard,
  TradingBotSummaryId,
  TradingBotsOverviewResponse as ApiTradingBotsOverviewResponse,
  TradingBotsSummaryResponse as ApiTradingBotsSummaryResponse,
} from "@/types/api";

export type TradingBotSummarySource = "api" | "fallback" | "placeholder";

export type TradingBotGuardrail = {
  label: string;
  value: string;
  tone?: TradingBotGuardrailTone;
};

export type TradingBotSummary = {
  id: TradingBotSummaryId;
  name: string;
  href: string;
  detailsHref: string;
  status: TradingBotStatus;
  mode: TradingBotMode;
  moneyInvested: number | null;
  currentValue: number | null;
  profitLoss: number | null;
  returnPct: number | null;
  activePositionsCount: number | null;
  tradesToday: number | null;
  lastRunTime: string | null;
  nextScheduledRun: string | null;
  guardrailsSummary: string;
  guardrails: TradingBotGuardrail[];
  strategy: string;
  riskWarning: string;
  note: string | null;
  source: TradingBotSummarySource;
};

export type TradingBotsOverview = {
  generatedAt: string;
  bots: TradingBotSummary[];
};

type PolymarketSummaryVariant = "bullpen" | "direct";

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const TRADING_BOT_CARD_ORDER: TradingBotSummaryId[] = [
  "bullpen-x-polymarket",
  "polymarket-direct",
  "bullpen-x-ai",
  "bullpen-ai-auto-live",
];

const AUTO_LIVE_STRATEGY =
  "Fully automated AI + evidence + market-rules based Bullpen trading engine. Scans markets, parses rules, builds shared evidence, runs LLM consensus, scores edges, sizes positions, rebalances active positions, and executes live limit orders only when all guardrails pass.";

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function normalizeSource(source?: string | null): TradingBotSummarySource {
  if (source === "fallback" || source === "placeholder") {
    return source;
  }

  return "api";
}

function toIstDateKey(iso?: string | null) {
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return IST_DATE_FORMATTER.format(date);
}

function isTodayIst(iso?: string | null) {
  const isoKey = toIstDateKey(iso);
  if (!isoKey) return false;

  return isoKey === IST_DATE_FORMATTER.format(new Date());
}

function formatMoney(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatInteger(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function mapPolymarketMode(mode: PolymarketBotState["mode"]): TradingBotMode {
  switch (mode) {
    case "live-read":
      return "live-read";
    case "live-trading":
      return "live-trading";
    case "mock":
    default:
      return "paper";
  }
}

function isBullpenLoginRequired(text: string) {
  return (
    text.includes("bullpen login required") ||
    text.includes("run: bullpen login") ||
    text.includes("session expired")
  );
}

function isDirectExecutionNotConfigured(text: string) {
  return (
    text.includes("direct execution not configured") ||
    text.includes("login required")
  );
}

function countPolymarketTradesToday(state: PolymarketBotState) {
  const historyCount = state.trade_history.filter((trade) =>
    isTodayIst(trade.timestamp),
  ).length;
  const recentDecisionCount = state.live.recent_decisions.filter((trade) =>
    isTodayIst(trade.executed_at || trade.proposed_at),
  ).length;

  return Math.max(
    state.live.live_trades_today || 0,
    historyCount + recentDecisionCount,
  );
}

function getPolymarketStatus(
  state: PolymarketBotState,
  variant: PolymarketSummaryVariant,
): TradingBotStatus {
  const liveError = state.live.source_status.last_live_read_error || "";
  const signalText = [
    state.last_error,
    state.live.doctor.message,
    state.live.balance.message,
    liveError,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (variant === "direct" && !state.running && isDirectExecutionNotConfigured(signalText)) {
    return "not-configured";
  }

  if (state.last_error) {
    return "error";
  }

  if (state.paused) {
    return "paused";
  }

  if (state.running) {
    if (
      liveError ||
      (!state.live.doctor.ok && !isBullpenLoginRequired(signalText))
    ) {
      return "error";
    }

    return "running";
  }

  if (
    variant === "direct" &&
    !state.started_at &&
    !state.tracked_accounts.length &&
    isDirectExecutionNotConfigured(signalText)
  ) {
    return "not-configured";
  }

  return "stopped";
}

function buildGuardrailsSummary(items: TradingBotGuardrail[]) {
  return items
    .slice(0, 4)
    .map((item) => `${item.label}: ${item.value}`)
    .join(" • ");
}

function getBaseTradingBotSummary(
  id: TradingBotSummaryId,
): TradingBotSummary {
  switch (id) {
    case "bullpen-x-polymarket":
      return {
        id,
        name: "Bullpen x Polymarket",
        href: URLs.routes.console.polymarketBot(),
        detailsHref: URLs.routes.console.polymarketBot(),
        status: "stopped",
        mode: "paper",
        moneyInvested: null,
        currentValue: null,
        profitLoss: null,
        returnPct: null,
        activePositionsCount: null,
        tradesToday: null,
        lastRunTime: null,
        nextScheduledRun: null,
        guardrailsSummary:
          "Live copy-trade guardrails will appear here once the bot state loads.",
        guardrails: [],
        strategy:
          "Copies eligible Bullpen trader activity into Polymarket positions after live-read filters, exposure checks, and execution guardrails pass.",
        riskWarning:
          "Copied trades can arrive late, liquidity can disappear fast, and session issues can delay exits.",
        note: null,
        source: "placeholder",
      };
    case "polymarket-direct":
      return {
        id,
        name: "Polymarket Direct",
        href: URLs.routes.console.polymarketDirectBot(),
        detailsHref: URLs.routes.console.polymarketDirectBot(),
        status: "stopped",
        mode: "paper",
        moneyInvested: null,
        currentValue: null,
        profitLoss: null,
        returnPct: null,
        activePositionsCount: null,
        tradesToday: null,
        lastRunTime: null,
        nextScheduledRun: null,
        guardrailsSummary:
          "Direct execution guardrails will appear here once the bot state loads.",
        guardrails: [],
        strategy:
          "Mirrors configured trader activity through the direct execution workflow with live-read discovery, live controls, and execution checks.",
        riskWarning:
          "Direct execution depends on account readiness, liquidity, and correct market mapping under live conditions.",
        note: null,
        source: "placeholder",
      };
    case "bullpen-x-ai":
      return {
        id,
        name: "Bullpen x AI",
        href: URLs.routes.console.bullpenAi(),
        detailsHref: URLs.routes.console.bullpenAi(),
        status: "stopped",
        mode: "analysis-only",
        moneyInvested: null,
        currentValue: null,
        profitLoss: null,
        returnPct: null,
        activePositionsCount: null,
        tradesToday: null,
        lastRunTime: null,
        nextScheduledRun: null,
        guardrailsSummary:
          "Bullpen scan and consensus guardrails will appear here once the overview endpoint is live.",
        guardrails: [],
        strategy:
          "Runs Bullpen scans, applies market filters, evaluates evidence, and produces LLM consensus before optional manual trading actions.",
        riskWarning:
          "Model drift, stale market rules, and manual execution lag can all distort edge estimates.",
        note: null,
        source: "placeholder",
      };
    case "bullpen-ai-auto-live":
    default:
      return {
        id: "bullpen-ai-auto-live",
        name: "Bullpen AI Auto-Live",
        href: URLs.routes.console.bullpenAiAutoLive(),
        detailsHref: URLs.routes.console.bullpenAiAutoLive(),
        status: "not-configured",
        mode: "dry-run",
        moneyInvested: null,
        currentValue: null,
        profitLoss: null,
        returnPct: null,
        activePositionsCount: null,
        tradesToday: null,
        lastRunTime: null,
        nextScheduledRun: null,
        guardrailsSummary:
          "Sizing, exposure, evidence, disagreement, and loss-stop guardrails are scaffolded and waiting for live config.",
        guardrails: [
          { label: "Max single trade", value: "Config pending" },
          { label: "Max market exposure", value: "Config pending" },
          { label: "Max theme exposure", value: "Config pending" },
          { label: "Max open exposure", value: "Config pending" },
          { label: "Cash reserve", value: "Config pending" },
          { label: "Min edge", value: "Config pending" },
          { label: "Max LLM disagreement", value: "Config pending" },
          { label: "Evidence requirement", value: "Config pending" },
          { label: "Daily/weekly loss stop", value: "Config pending" },
          { label: "Limit orders only", value: "Required", tone: "positive" },
          { label: "Emergency stop status", value: "Standing by" },
        ],
        strategy: AUTO_LIVE_STRATEGY,
        riskWarning:
          "Full automation can compound model, evidence, and execution errors quickly once live trading is enabled.",
        note:
          "Overview placeholder is wired and ready for backend summary data when the auto-live service is exposed.",
        source: "placeholder",
      };
  }
}

function normalizeGuardrails(
  guardrails: ApiTradingBotGuardrail[] | null | undefined,
  fallback: TradingBotGuardrail[],
) {
  if (!Array.isArray(guardrails) || guardrails.length === 0) {
    return fallback;
  }

  return guardrails
    .filter((guardrail) => guardrail.label && guardrail.value)
    .map((guardrail) => ({
      label: guardrail.label,
      value: guardrail.value,
      tone: guardrail.tone || "neutral",
    }));
}

function normalizeOverviewCard(card: ApiTradingBotOverviewCard): TradingBotSummary {
  const base = getBaseTradingBotSummary(card.id);

  return {
    ...base,
    name: card.name || base.name,
    href: card.href || base.href,
    detailsHref: card.details_href || card.href || base.detailsHref,
    status: card.status || base.status,
    mode: card.mode || base.mode,
    moneyInvested: card.money_invested,
    currentValue: card.current_value,
    profitLoss: card.profit_loss,
    returnPct: card.return_pct,
    activePositionsCount: card.active_positions_count,
    tradesToday: card.trades_today,
    lastRunTime: card.last_run_time,
    nextScheduledRun: card.next_scheduled_run,
    guardrailsSummary: card.guardrails_summary || base.guardrailsSummary,
    guardrails: normalizeGuardrails(card.guardrails, base.guardrails),
    strategy: card.strategy || base.strategy,
    riskWarning: card.risk_warning || base.riskWarning,
    note: card.note || base.note,
    source: normalizeSource(card.source),
  };
}

function normalizeSummaryCard(card: ApiTradingBotSummaryCard): TradingBotSummary {
  const base = getBaseTradingBotSummary(card.id);

  return {
    ...base,
    name: card.name || base.name,
    href: card.route || base.href,
    detailsHref: card.route || base.detailsHref,
    status: card.status || base.status,
    mode: card.mode || base.mode,
    moneyInvested: card.invested_usd ?? null,
    currentValue: card.current_value_usd ?? null,
    profitLoss: card.pnl_usd ?? null,
    returnPct: card.return_pct ?? null,
    activePositionsCount: card.active_positions ?? null,
    tradesToday: card.trades_today ?? null,
    lastRunTime: card.last_run_at ?? null,
    nextScheduledRun: card.next_run_at ?? null,
    guardrailsSummary: card.guardrails_summary || base.guardrailsSummary,
    guardrails: normalizeGuardrails(card.guardrails, base.guardrails),
    strategy: card.strategy_summary || base.strategy,
    riskWarning: card.risk_summary || base.riskWarning,
    note: card.note || base.note,
    source: normalizeSource(card.source),
  };
}

export function normalizeTradingBotsOverviewResponse(
  overview: ApiTradingBotsOverviewResponse,
): TradingBotsOverview {
  return {
    generatedAt: overview.generated_at || new Date().toISOString(),
    bots: sortTradingBots(overview.bots.map((bot) => normalizeOverviewCard(bot))),
  };
}

export function normalizeTradingBotsSummaryResponse(
  summary: ApiTradingBotsSummaryResponse,
): TradingBotsOverview {
  return {
    generatedAt: summary.generated_at || new Date().toISOString(),
    bots: sortTradingBots(summary.cards.map((card) => normalizeSummaryCard(card))),
  };
}

export function sortTradingBots(bots: TradingBotSummary[]) {
  const botById = new Map(bots.map((bot) => [bot.id, bot]));

  return TRADING_BOT_CARD_ORDER.map((id) => botById.get(id) || getBaseTradingBotSummary(id));
}

export function buildTradingBotsOverviewShell(note?: string): TradingBotsOverview {
  return {
    generatedAt: new Date().toISOString(),
    bots: sortTradingBots(
      TRADING_BOT_CARD_ORDER.map((id) => {
        const base = getBaseTradingBotSummary(id);
        if (!note || base.note) {
          return base;
        }

        return {
          ...base,
          note,
        };
      }),
    ),
  };
}

export function mergeTradingBotsOverview(
  preferred: TradingBotsOverview | null,
  fallback: TradingBotsOverview,
): TradingBotsOverview {
  if (!preferred) {
    return {
      ...fallback,
      bots: sortTradingBots(fallback.bots),
    };
  }

  const fallbackById = new Map(fallback.bots.map((bot) => [bot.id, bot]));
  const preferredById = new Map(preferred.bots.map((bot) => [bot.id, bot]));

  return {
    generatedAt: preferred.generatedAt || fallback.generatedAt,
    bots: TRADING_BOT_CARD_ORDER.map((id) => ({
      ...(fallbackById.get(id) || getBaseTradingBotSummary(id)),
      ...(preferredById.get(id) || {}),
    })),
  };
}

export function buildPolymarketTradingBotSummary(
  id: "bullpen-x-polymarket" | "polymarket-direct",
  state: PolymarketBotState,
): TradingBotSummary {
  const isBullpenVariant = id === "bullpen-x-polymarket";
  const variant: PolymarketSummaryVariant = isBullpenVariant ? "bullpen" : "direct";
  const invested = roundCurrency(
    state.open_positions.reduce(
      (total, position) => total + (position.cost_basis || 0),
      0,
    ),
  );
  const currentValue =
    state.live.balance.account_value_usd ??
    (state.metrics.total_pnl != null
      ? roundCurrency(invested + state.metrics.total_pnl)
      : null);
  const profitLoss =
    state.metrics.total_pnl != null
      ? roundCurrency(state.metrics.total_pnl)
      : currentValue != null
        ? roundCurrency(currentValue - invested)
        : null;
  const returnPct =
    invested > 0 && profitLoss != null
      ? roundCurrency((profitLoss / invested) * 100)
      : null;

  const guardrails: TradingBotGuardrail[] = isBullpenVariant
    ? [
        {
          label: "Fixed copy size",
          value: formatMoney(state.config.fixed_copy_trade_size),
        },
        {
          label: "Max live trade",
          value: formatMoney(state.live.max_live_trade_size || state.config.max_live_trade_size),
        },
        {
          label: "Max market exposure",
          value: formatMoney(state.config.max_live_exposure_per_market),
        },
        {
          label: "Daily live loss stop",
          value: formatMoney(state.config.max_live_daily_loss),
          tone: "warning",
        },
        {
          label: "Pending confirmations",
          value: formatInteger(state.live.pending_confirmations.length),
        },
        {
          label: "Emergency stop",
          value: state.live.emergency_stopped ? "Active" : "Clear",
          tone: state.live.emergency_stopped ? "critical" : "positive",
        },
      ]
    : [
        {
          label: "Max live trade",
          value: formatMoney(state.live.max_live_trade_size || state.config.max_live_trade_size),
        },
        {
          label: "Max live trades/day",
          value: formatInteger(state.config.max_live_trades_per_day),
        },
        {
          label: "Max market exposure",
          value: formatMoney(state.config.max_live_exposure_per_market),
        },
        {
          label: "Daily live loss stop",
          value: formatMoney(state.config.max_live_daily_loss),
          tone: "warning",
        },
        {
          label: "Manual confirmation",
          value: state.config.require_manual_confirmation ? "Required" : "Auto",
        },
        {
          label: "Emergency stop",
          value: state.live.emergency_stopped ? "Active" : "Clear",
          tone: state.live.emergency_stopped ? "critical" : "positive",
        },
      ];

  const note =
    state.last_error ||
    state.live.source_status.last_live_read_error ||
    (state.live.doctor.ok ? null : state.live.doctor.message) ||
    null;

  return {
    ...getBaseTradingBotSummary(id),
    status: getPolymarketStatus(state, variant),
    mode: mapPolymarketMode(state.mode),
    moneyInvested: invested > 0 ? invested : null,
    currentValue,
    profitLoss,
    returnPct,
    activePositionsCount: state.open_positions.filter((position) => position.shares > 0).length,
    tradesToday: countPolymarketTradesToday(state),
    lastRunTime: state.last_poll_at || state.started_at || state.session_started_at || null,
    nextScheduledRun: state.running ? state.next_poll_at || null : null,
    guardrailsSummary: buildGuardrailsSummary(guardrails),
    guardrails,
    note,
    source: "fallback",
  };
}

export function buildBullpenAiTradingBotSummary(
  payload?: BullpenPositionsResponse | null,
  errorMessage?: string | null,
): TradingBotSummary {
  const base = getBaseTradingBotSummary("bullpen-x-ai");
  const activeCount =
    payload?.summary?.activeCount ??
    payload?.positions?.length ??
    null;
  const currentValue =
    payload?.summary?.walletValue ??
    payload?.summary?.totalValue ??
    null;
  const profitLoss = payload?.summary?.unrealizedPnl ?? null;
  const moneyInvested =
    currentValue != null && profitLoss != null
      ? roundCurrency(currentValue - profitLoss)
      : null;
  const returnPct =
    moneyInvested != null && moneyInvested > 0 && profitLoss != null
      ? roundCurrency((profitLoss / moneyInvested) * 100)
      : null;
  const guardrails: TradingBotGuardrail[] = [
    { label: "Selection filters", value: "Active market filters" },
    { label: "Evidence check", value: "Consensus review required" },
    { label: "Pink-row threshold", value: "LLM No > 80% and returns/day > 5%" },
    { label: "Sizing logic", value: "Amount-to-invest formula" },
    { label: "Execution", value: "Manual review before live invest" },
  ];
  const note =
    errorMessage ||
    payload?.error ||
    "Overview is using Bullpen wallet positions until a dedicated bot summary endpoint is available.";

  return {
    ...base,
    status: errorMessage ? "not-configured" : "running",
    mode: "analysis-only",
    moneyInvested,
    currentValue,
    profitLoss,
    returnPct,
    activePositionsCount: activeCount,
    tradesToday: null,
    lastRunTime: payload?.fetchedAt || null,
    nextScheduledRun: null,
    guardrailsSummary: buildGuardrailsSummary(guardrails),
    guardrails,
    note,
    source: errorMessage ? "placeholder" : "fallback",
  };
}

export function buildBullpenAiAutoLiveTradingBotSummary(
  payload?: BullpenAutoLiveSummaryResponse | null,
  errorMessage?: string | null,
): TradingBotSummary {
  const base = getBaseTradingBotSummary("bullpen-ai-auto-live");
  const botCard = payload?.bot_card;
  const guardrails = normalizeGuardrails(botCard?.guardrails, base.guardrails);
  const note =
    errorMessage ||
    payload?.state.last_error ||
    payload?.latest_run?.error_message ||
    payload?.state.last_action ||
    base.note;

  return {
    ...base,
    status: botCard?.status || payload?.state.status || base.status,
    mode: botCard?.mode || payload?.state.mode || base.mode,
    moneyInvested: botCard?.invested_usd ?? payload?.state.invested_usd ?? null,
    currentValue:
      botCard?.current_value_usd ?? payload?.state.current_value_usd ?? null,
    profitLoss: botCard?.pnl_usd ?? payload?.state.pnl_usd ?? null,
    returnPct: botCard?.return_pct ?? base.returnPct,
    activePositionsCount:
      botCard?.active_positions ?? payload?.state.active_positions ?? null,
    tradesToday: botCard?.trades_today ?? payload?.state.trades_today ?? null,
    lastRunTime:
      botCard?.last_run_at ||
      payload?.state.last_run_at ||
      payload?.latest_run?.completed_at ||
      payload?.latest_run?.started_at ||
      null,
    nextScheduledRun: botCard?.next_run_at || payload?.state.next_run_at || null,
    guardrailsSummary:
      botCard?.guardrails_summary || buildGuardrailsSummary(guardrails),
    guardrails,
    strategy: botCard?.strategy_summary || base.strategy,
    riskWarning: botCard?.risk_summary || base.riskWarning,
    note,
    source: errorMessage ? "fallback" : "api",
  };
}

export function buildUnavailableTradingBotSummary(
  id: TradingBotSummaryId,
  note: string,
): TradingBotSummary {
  return {
    ...getBaseTradingBotSummary(id),
    status: "error",
    note,
    source: "fallback",
  };
}

export function buildBullpenAiAutoLiveSummary() {
  return getBaseTradingBotSummary("bullpen-ai-auto-live");
}
