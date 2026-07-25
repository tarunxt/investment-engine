"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BullpenPositionsResponse } from "@/lib/bullpenPositions";
import {
  buildBullpenAiAutoLiveTradingBotSummary,
  buildBullpenAiTradingBotSummary,
  buildPolymarketTradingBotSummary,
  buildTradingBotsOverviewShell,
  mergeTradingBotsOverview,
  normalizeTradingBotsSummaryResponse,
  type TradingBotGuardrail,
  type TradingBotSummary,
  type TradingBotsOverview,
} from "@/lib/tradingBots";
import { cn } from "@/lib/utils";
import { APIError, apiService } from "@/services/api";

import {
  buildTradingBotsLiveWarnings,
  buildTradingBotsPortfolioSummary,
  getTradingBotDecisionItems,
  getTradingBotExecutionModeDetail,
  getTradingBotPresentation,
  getTradingBotRiskStatus,
  getTradingBotTopGuardrails,
  getTradingBotWarnings,
  type TradingBotsOverviewDetails,
} from "./tradingBotsOverviewData";

const OVERVIEW_CACHE_KEY = "investment-engine:trading-bots-overview:v2";
const PREFERRED_OVERVIEW_TIMEOUT_MS = 2_000;
const FAST_BOT_TIMEOUT_MS = 2_500;
const BULLPEN_AI_TIMEOUT_MS = 2_500;
const AUTO_LIVE_TIMEOUT_MS = 2_500;
const INITIAL_OVERVIEW = buildTradingBotsOverviewShell(
  "Loading latest trading bot status in the background.",
);
const INITIAL_DETAILS: TradingBotsOverviewDetails = {
  "bullpen-x-polymarket": null,
  "polymarket-direct": null,
  "bullpen-x-ai": null,
  "bullpen-ai-auto-live": null,
};

const STATUS_LABELS: Record<TradingBotSummary["status"], string> = {
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  error: "Error",
  "not-configured": "Not configured",
};

const MODE_LABELS: Record<TradingBotSummary["mode"], string> = {
  paper: "Paper",
  "live-read": "Live-read",
  "live-trading": "Live-trading",
  "dry-run": "Dry-run",
  "analysis-only": "Analysis-only",
};

function normalizeError(error: unknown) {
  if (error instanceof APIError) {
    return `HTTP ${error.status}: ${error.message}`;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function getDisplayableOverviewError(error: unknown) {
  if (error instanceof APIError && [404, 405].includes(error.status)) {
    return null;
  }

  return normalizeError(error);
}

function formatMoney(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";

  return `${value.toFixed(2)}%`;
}

function formatCount(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  return parsed.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function getProfitToneClass(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "text-slate-950";
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-950";
}

function getStatusBadgeClass(status: TradingBotSummary["status"]) {
  switch (status) {
    case "running":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "paused":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "stopped":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "error":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "not-configured":
    default:
      return "border-sky-200 bg-sky-50 text-sky-700";
  }
}

function getModeBadgeClass(mode: TradingBotSummary["mode"]) {
  switch (mode) {
    case "paper":
      return "border-slate-200 bg-white text-slate-700";
    case "live-read":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "live-trading":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "dry-run":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "analysis-only":
    default:
      return "border-indigo-200 bg-indigo-50 text-indigo-700";
  }
}

function getGuardrailToneClass(tone?: TradingBotGuardrail["tone"]) {
  switch (tone) {
    case "positive":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "critical":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "neutral":
    default:
      return "border-slate-200 bg-white text-slate-700";
  }
}

function getRiskToneClass(
  tone: "neutral" | "positive" | "warning" | "critical",
) {
  switch (tone) {
    case "positive":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "critical":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "neutral":
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function getDecisionToneClass(
  tone: "neutral" | "positive" | "warning" | "critical",
) {
  switch (tone) {
    case "positive":
      return "border-emerald-100 bg-emerald-50/80";
    case "warning":
      return "border-amber-100 bg-amber-50/80";
    case "critical":
      return "border-rose-100 bg-rose-50/80";
    case "neutral":
    default:
      return "border-slate-200 bg-white";
  }
}

function getRoleTheme(botId: TradingBotSummary["id"]) {
  switch (botId) {
    case "bullpen-x-polymarket":
      return {
        card:
          "border-sky-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.08),_transparent_30%),#ffffff] dark:border-slate-700/80 dark:bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_34%),linear-gradient(180deg,_rgba(15,23,42,0.92)_0%,_rgba(2,6,23,0.98)_100%)]",
        icon:
          "border-sky-200 bg-sky-50 text-sky-700 shadow-[0_12px_30px_-20px_rgba(2,132,199,0.8)] dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100",
        panel:
          "border-sky-200 bg-sky-50/70 text-sky-900 dark:border-sky-400/25 dark:bg-sky-500/10 dark:text-sky-100",
        label: "text-sky-800 dark:text-sky-200",
      };
    case "polymarket-direct":
      return {
        card:
          "border-cyan-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.08),_transparent_30%),#ffffff] dark:border-slate-700/80 dark:bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.18),_transparent_34%),linear-gradient(180deg,_rgba(15,23,42,0.92)_0%,_rgba(2,6,23,0.98)_100%)]",
        icon:
          "border-cyan-200 bg-cyan-50 text-cyan-700 shadow-[0_12px_30px_-20px_rgba(8,145,178,0.8)] dark:border-cyan-400/30 dark:bg-cyan-500/10 dark:text-cyan-100",
        panel:
          "border-cyan-200 bg-cyan-50/70 text-cyan-900 dark:border-cyan-400/25 dark:bg-cyan-500/10 dark:text-cyan-100",
        label: "text-cyan-800 dark:text-cyan-200",
      };
    case "bullpen-x-ai":
      return {
        card:
          "border-indigo-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(99,102,241,0.10),_transparent_32%),#ffffff] dark:border-slate-700/80 dark:bg-[radial-gradient(circle_at_top_left,_rgba(99,102,241,0.18),_transparent_34%),linear-gradient(180deg,_rgba(15,23,42,0.92)_0%,_rgba(2,6,23,0.98)_100%)]",
        icon:
          "border-indigo-200 bg-indigo-50 text-indigo-700 shadow-[0_12px_30px_-20px_rgba(79,70,229,0.85)] dark:border-indigo-400/30 dark:bg-indigo-500/10 dark:text-indigo-100",
        panel:
          "border-indigo-200 bg-indigo-50/75 text-indigo-900 dark:border-indigo-400/25 dark:bg-indigo-500/10 dark:text-indigo-100",
        label: "text-indigo-800 dark:text-indigo-200",
      };
    case "bullpen-ai-auto-live":
    default:
      return {
        card:
          "border-emerald-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.10),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.10),_transparent_34%),#ffffff] dark:border-slate-700/80 dark:bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_32%),radial-gradient(circle_at_top_right,_rgba(245,158,11,0.14),_transparent_34%),linear-gradient(180deg,_rgba(15,23,42,0.92)_0%,_rgba(2,6,23,0.98)_100%)]",
        icon:
          "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-[0_12px_30px_-20px_rgba(5,150,105,0.85)] dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100",
        panel:
          "border-emerald-200 bg-emerald-50/75 text-emerald-950 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-100",
        label: "text-emerald-800 dark:text-emerald-200",
      };
  }
}

function isTradingBotSummary(value: unknown): value is TradingBotSummary {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.href === "string" &&
    typeof record.detailsHref === "string"
  );
}

function readCachedOverview() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(OVERVIEW_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      generatedAt?: unknown;
      bots?: unknown;
    };
    if (
      typeof parsed.generatedAt !== "string" ||
      !Array.isArray(parsed.bots)
    ) {
      return null;
    }

    return mergeTradingBotsOverview(null, {
      generatedAt: parsed.generatedAt,
      bots: parsed.bots.filter(isTradingBotSummary),
    } satisfies TradingBotsOverview);
  } catch {
    return null;
  }
}

function writeCachedOverview(overview: TradingBotsOverview) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify(overview));
}

function usesFallbackData(overview: TradingBotsOverview) {
  return overview.bots.some((bot) => bot.source !== "api");
}

function upsertBotSummary(
  overview: TradingBotsOverview,
  nextBot: TradingBotSummary,
): TradingBotsOverview {
  return {
    generatedAt: new Date().toISOString(),
    bots: overview.bots.map((bot) => (bot.id === nextBot.id ? nextBot : bot)),
  };
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (/timed out/i.test(error.message) || error.name === "AbortError")
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timerId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timerId);
        reject(error);
      },
    );
  });
}

async function fetchBullpenAiPositions(timeoutMs = BULLPEN_AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("/api/bullpen-ai/positions", {
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json()) as BullpenPositionsResponse;

    if (!response.ok) {
      throw new Error(
        payload.error || "Unable to load Bullpen x AI position data right now.",
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Bullpen x AI positions timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    window.clearTimeout(timerId);
  }
}

function MetricTile({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: string;
  value: string;
  detail: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/70 bg-white/85 px-4 py-4 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.55)] backdrop-blur">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-3 text-lg font-semibold tracking-tight text-slate-950",
          valueClassName,
        )}
      >
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{detail}</p>
    </div>
  );
}

function TradingBotCard({
  bot,
  details,
  expanded,
  onToggle,
}: {
  bot: TradingBotSummary;
  details: TradingBotsOverviewDetails;
  expanded: boolean;
  onToggle: () => void;
}) {
  const presentation = getTradingBotPresentation(bot.id);
  const riskStatus = getTradingBotRiskStatus(bot, details);
  const warnings = getTradingBotWarnings(bot, details);
  const recentItems = getTradingBotDecisionItems(bot, details);
  const topGuardrails = getTradingBotTopGuardrails(bot.guardrails);
  const theme = getRoleTheme(bot.id);
  const Icon = presentation.icon;
  const profitTone = getProfitToneClass(bot.profitLoss);
  const statItems = [
    { label: "Invested", value: formatMoney(bot.moneyInvested) },
    { label: "Current value", value: formatMoney(bot.currentValue) },
    {
      label: "P&L",
      value: formatMoney(bot.profitLoss),
      valueClassName: profitTone,
    },
    {
      label: "Return %",
      value: formatPercent(bot.returnPct),
      valueClassName: profitTone,
    },
    { label: "Active positions", value: formatCount(bot.activePositionsCount) },
    { label: "Trades today", value: formatCount(bot.tradesToday) },
    { label: "Last run", value: formatDateTime(bot.lastRunTime) },
    { label: "Next run", value: formatDateTime(bot.nextScheduledRun) },
  ];

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden rounded-[32px] border py-0 shadow-[0_22px_50px_-32px_rgba(15,23,42,0.38)]",
        theme.card,
      )}
    >
      <CardHeader className="gap-5 border-b border-slate-200/70 px-6 py-6 sm:px-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 space-y-4">
            <div className="flex items-start gap-4">
              <div
                className={cn(
                  "flex size-12 shrink-0 items-center justify-center rounded-2xl border",
                  theme.icon,
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-lg tracking-tight text-slate-950">
                    {bot.name}
                  </CardTitle>
                  <span
                    className={cn(
                      "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                      getStatusBadgeClass(bot.status),
                    )}
                  >
                    {STATUS_LABELS[bot.status]}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                      getModeBadgeClass(bot.mode),
                    )}
                  >
                    {MODE_LABELS[bot.mode]}
                  </span>
                </div>
                <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                  {presentation.strategy}
                </CardDescription>
              </div>
            </div>

            <div
              className={cn(
                "max-w-3xl rounded-[24px] border px-4 py-4",
                theme.panel,
              )}
            >
              <p
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-[0.2em]",
                  theme.label,
                )}
              >
                {presentation.roleLabel}
              </p>
              <p className="mt-2 text-sm leading-6">{presentation.roleDetail}</p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              asChild
              size="sm"
              className="rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
            >
              <Link href={bot.href}>Open</Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onToggle}
              className="rounded-full border-slate-300 bg-white/90 px-5"
            >
              Details
              {expanded ? (
                <ChevronUp className="ml-2 size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="ml-2 size-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6 px-6 py-6 sm:px-7">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {statItems.map((item) => (
            <div
              key={item.label}
              className="rounded-[22px] border border-slate-200/80 bg-white/90 px-4 py-3"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                {item.label}
              </p>
              <p
                className={cn(
                  "mt-2 text-sm font-semibold text-slate-950",
                  item.valueClassName,
                )}
              >
                {item.value}
              </p>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="rounded-[24px] border border-slate-200 bg-white/90 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Top 3 guardrails
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {topGuardrails.length > 0 ? (
                topGuardrails.map((guardrail) => (
                  <span
                    key={`${guardrail.label}-${guardrail.value}`}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium",
                      getGuardrailToneClass(guardrail.tone),
                    )}
                  >
                    {guardrail.label}: {guardrail.value}
                  </span>
                ))
              ) : (
                <span className="text-sm text-slate-600">
                  Guardrail details will populate as this bot reports live state.
                </span>
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-slate-200 bg-white/90 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Risk status
            </p>
            <div className="mt-3 flex items-start gap-3">
              <span
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  getRiskToneClass(riskStatus.tone),
                )}
              >
                {riskStatus.label}
              </span>
              <p className="min-w-0 text-sm leading-6 text-slate-700">
                {riskStatus.detail}
              </p>
            </div>
          </div>
        </div>

        {expanded ? (
          <div className="space-y-6 border-t border-slate-200/80 pt-6">
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-3 rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Workflow / strategy being used
                </p>
                <p className="text-sm leading-6 text-slate-700">
                  {presentation.workflow}
                </p>
              </div>

              <div className="space-y-3 rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Execution mode
                </p>
                <p className="text-sm leading-6 text-slate-700">
                  {getTradingBotExecutionModeDetail(bot)}
                </p>
              </div>

              <div className="space-y-3 rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Guardrails
                </p>
                <div className="flex flex-wrap gap-2">
                  {bot.guardrails.length > 0 ? (
                    bot.guardrails.map((guardrail) => (
                      <span
                        key={`${guardrail.label}-${guardrail.value}`}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-medium",
                          getGuardrailToneClass(guardrail.tone),
                        )}
                      >
                        {guardrail.label}: {guardrail.value}
                      </span>
                    ))
                  ) : (
                    <p className="text-sm text-slate-600">
                      No additional guardrail details reported yet.
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-3 rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Data sources
                </p>
                <ul className="space-y-2 text-sm leading-6 text-slate-700">
                  {presentation.dataSources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <div className="rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Last 5 decisions / trades
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {presentation.decisionsFallback}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {recentItems.length > 0 ? (
                    recentItems.map((item) => (
                      <div
                        key={item.id}
                        className={cn(
                          "rounded-[20px] border px-4 py-3",
                          getDecisionToneClass(item.tone),
                        )}
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900">
                              {item.title}
                            </p>
                            <p className="mt-1 text-sm leading-6 text-slate-600">
                              {item.detail}
                            </p>
                          </div>
                          <p className="shrink-0 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                            {formatDateTime(item.timestamp)}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[20px] border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                      No recent decisions or trades are available in the overview yet.
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Known warnings / errors
                  </p>
                  <div className="mt-4 space-y-3">
                    {warnings.length > 0 ? (
                      warnings.map((warning) => (
                        <div
                          key={warning}
                          className="rounded-[20px] border border-amber-200 bg-amber-50/85 px-4 py-3 text-sm leading-6 text-amber-900"
                        >
                          {warning}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-[20px] border border-emerald-200 bg-emerald-50/85 px-4 py-3 text-sm leading-6 text-emerald-900">
                        No known warnings or errors are surfaced for this bot from the overview sources right now.
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-[24px] border border-slate-200 bg-white/90 px-5 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Logs / history
                  </p>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    Use the full bot console for the deeper run log, history, and execution controls.
                  </p>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="mt-4 rounded-full border-slate-300 px-5"
                  >
                    <Link href={presentation.logsHref}>
                      Open logs/history
                      <ExternalLink className="ml-2 size-3.5" aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function TradingBotsOverviewPage() {
  const [overview, setOverview] = useState<TradingBotsOverview>(INITIAL_OVERVIEW);
  const [details, setDetails] =
    useState<TradingBotsOverviewDetails>(INITIAL_DETAILS);
  const [expandedBots, setExpandedBots] = useState<Record<string, boolean>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingLatest, setIsLoadingLatest] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    writeCachedOverview(overview);
  }, [overview]);

  async function refreshOverview({
    silent = false,
  }: {
    silent?: boolean;
  } = {}) {
    if (!silent) {
      setIsRefreshing(true);
    }
    setIsLoadingLatest(true);

    const errors: string[] = [];

    try {
      setLoadError(null);

      const preferredOverviewPromise = withTimeout(
        apiService.getTradingBotsSummary(),
        PREFERRED_OVERVIEW_TIMEOUT_MS,
        "Trading Bots summary",
      )
        .then((response) => {
          const normalized = normalizeTradingBotsSummaryResponse(response);
          startTransition(() => {
            setOverview((current) =>
              mergeTradingBotsOverview(normalized, current),
            );
          });
        })
        .catch((error) => {
          const displayableError = getDisplayableOverviewError(error);
          if (displayableError && !isTimeoutError(error)) {
            errors.push(displayableError);
          }
        });

      const detailPromises: Promise<void>[] = [
        withTimeout(
          apiService.polymarketState(),
          FAST_BOT_TIMEOUT_MS,
          "Bullpen x Polymarket state",
        )
          .then((state) => {
            startTransition(() => {
              setDetails((current) => ({
                ...current,
                "bullpen-x-polymarket": state,
              }));
              setOverview((current) =>
                upsertBotSummary(
                  current,
                  buildPolymarketTradingBotSummary(
                    "bullpen-x-polymarket",
                    state,
                  ),
                ),
              );
            });
          })
          .catch((error) => {
            if (!isTimeoutError(error)) {
              errors.push(normalizeError(error));
            }
          }),
        withTimeout(
          apiService.polymarketDirectState(),
          FAST_BOT_TIMEOUT_MS,
          "Polymarket Direct state",
        )
          .then((state) => {
            startTransition(() => {
              setDetails((current) => ({
                ...current,
                "polymarket-direct": state,
              }));
              setOverview((current) =>
                upsertBotSummary(
                  current,
                  buildPolymarketTradingBotSummary("polymarket-direct", state),
                ),
              );
            });
          })
          .catch((error) => {
            if (!isTimeoutError(error)) {
              errors.push(normalizeError(error));
            }
          }),
        fetchBullpenAiPositions()
          .then((payload) => {
            startTransition(() => {
              setDetails((current) => ({
                ...current,
                "bullpen-x-ai": payload,
              }));
              setOverview((current) =>
                upsertBotSummary(
                  current,
                  buildBullpenAiTradingBotSummary(payload),
                ),
              );
            });
          })
          .catch((error) => {
            if (!isTimeoutError(error)) {
              errors.push(normalizeError(error));
            }
          }),
        withTimeout(
          apiService.getBullpenAutoLiveDashboardSummary(),
          AUTO_LIVE_TIMEOUT_MS,
          "Bullpen AI Auto-Live summary",
        )
          .then((summary) => {
            startTransition(() => {
              setDetails((current) => ({
                ...current,
                "bullpen-ai-auto-live": summary,
              }));
              setOverview((current) =>
                upsertBotSummary(
                  current,
                  buildBullpenAiAutoLiveTradingBotSummary(summary),
                ),
              );
            });
          })
          .catch((error) => {
            if (!isTimeoutError(error)) {
              errors.push(normalizeError(error));
            }
          }),
      ];

      await Promise.allSettled([preferredOverviewPromise, ...detailPromises]);

      if (errors.length > 0) {
        setLoadError(errors.join(" • "));
      }
    } finally {
      setIsLoadingLatest(false);
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    const cachedOverview = readCachedOverview();
    if (cachedOverview) {
      startTransition(() => {
        setOverview(cachedOverview);
      });
    }

    const refreshTimer = window.setTimeout(() => {
      void refreshOverview({ silent: true });
    }, 0);

    return () => window.clearTimeout(refreshTimer);
  }, []);

  const bots = overview.bots;
  const usingFallback = usesFallbackData(overview);
  const portfolioSummary = buildTradingBotsPortfolioSummary(
    bots,
    details,
    overview.generatedAt || null,
  );
  const liveWarnings = buildTradingBotsLiveWarnings(bots, details);

  const summaryTiles = [
    {
      label: "Total money invested",
      value: formatMoney(portfolioSummary.totalMoneyInvested),
      detail: "Capital currently allocated across all reported bot balances.",
    },
    {
      label: "Total current value",
      value: formatMoney(portfolioSummary.totalCurrentValue),
      detail: "Combined current value from the bot sources that have loaded so far.",
    },
    {
      label: "Total P&L",
      value: formatMoney(portfolioSummary.totalProfitLoss),
      detail: "Aggregate profit and loss across the overview's reported positions.",
      valueClassName: getProfitToneClass(portfolioSummary.totalProfitLoss),
    },
    {
      label: "Total return %",
      value: formatPercent(portfolioSummary.totalReturnPct),
      detail: "Overall return based on currently available invested capital data.",
      valueClassName: getProfitToneClass(portfolioSummary.totalProfitLoss),
    },
    {
      label: "Total active positions",
      value: formatCount(portfolioSummary.totalActivePositions),
      detail: "Open positions currently being tracked across the four bots.",
    },
    {
      label: "Total trades today",
      value: formatCount(portfolioSummary.totalTradesToday),
      detail: "Sum of per-bot trade counts reported for today.",
    },
    {
      label: "Bots running",
      value: formatCount(portfolioSummary.botsRunning),
      detail: `Currently active bots out of ${bots.length} total.`,
    },
    {
      label: "Bots paused/stopped",
      value: formatCount(portfolioSummary.botsPausedStopped),
      detail: "Includes paused, stopped, error, and setup-needed bots.",
    },
    {
      label: "Live exposure",
      value: formatMoney(portfolioSummary.liveExposure),
      detail: "Exposure on bots currently in live-read or live-trading modes.",
    },
    {
      label: "Dry-run exposure",
      value: formatMoney(portfolioSummary.dryRunExposure),
      detail: "Exposure tied to paper, dry-run, or analysis-only workflows.",
    },
    {
      label: "Highest risk bot",
      value: portfolioSummary.highestRiskBot?.name || "—",
      detail: portfolioSummary.highestRiskStatus
        ? `${portfolioSummary.highestRiskStatus.label} • ${portfolioSummary.highestRiskStatus.detail}`
        : "Risk posture will update as each bot reports state.",
    },
    {
      label: "Last updated",
      value: formatDateTime(portfolioSummary.lastUpdated),
      detail: "Most recent timestamp for this shared overview snapshot.",
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 pb-8">
      <div className="overflow-hidden rounded-[32px] border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.12),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.12),_transparent_30%),linear-gradient(180deg,_rgba(255,255,255,0.98)_0%,_rgba(248,250,252,0.98)_100%)] px-6 py-6 shadow-[0_26px_70px_-42px_rgba(15,23,42,0.45)] dark:border-slate-700/80 dark:bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.16),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.14),_transparent_30%),linear-gradient(180deg,_rgba(15,23,42,0.96)_0%,_rgba(2,6,23,1)_100%)] dark:shadow-[0_26px_70px_-42px_rgba(2,6,23,0.92)] sm:px-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center rounded-full border border-white/80 bg-white/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600 shadow-sm">
              Trading Bots Control Center
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
                Overview
              </h1>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
                One shared operating surface for Bullpen x Polymarket, Polymarket Direct, Bullpen x AI, and Bullpen AI Auto-Live. Review capital, runtime posture, risk signals, and recent activity without losing the dedicated bot consoles.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-full border border-white/80 bg-white/90 px-4 py-2 text-xs text-slate-500 shadow-sm">
              Last refreshed {formatDateTime(overview.generatedAt || null)}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshOverview()}
              disabled={isRefreshing}
              className="rounded-full border-slate-300 bg-white/90 px-5"
            >
              <RefreshCw
                className={cn("mr-2 size-3.5", isRefreshing ? "animate-spin" : "")}
                aria-hidden="true"
              />
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {summaryTiles.map((tile) => (
            <MetricTile key={tile.label} {...tile} />
          ))}
        </div>
      </div>

      {liveWarnings.length > 0 ? (
        <div className="rounded-[28px] border border-rose-200 bg-rose-50/90 px-5 py-4 shadow-[0_18px_48px_-36px_rgba(225,29,72,0.6)]">
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-rose-700"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-rose-900">
                Live bot warnings need attention
              </p>
              <div className="mt-3 grid gap-2">
                {liveWarnings.map((warning) => (
                  <div
                    key={warning.key}
                    className="rounded-[20px] border border-rose-200 bg-white/70 px-4 py-3 text-sm leading-6 text-rose-900"
                  >
                    <span className="font-semibold">{warning.botName}</span>:{" "}
                    {warning.label}. {warning.detail}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {usingFallback ? (
        <div className="flex items-start gap-3 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            This overview paints cached or placeholder data first, then hydrates each bot card with live state in the background as those sources return.
          </p>
        </div>
      ) : null}

      {isLoadingLatest ? (
        <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Loading the latest shared bot state in the background. The control center stays interactive while slower sources catch up.
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Some bot data is unavailable right now: {loadError}
        </div>
      ) : null}

      <div className="grid gap-5">
        {bots.map((bot) => (
          <TradingBotCard
            key={bot.id}
            bot={bot}
            details={details}
            expanded={Boolean(expandedBots[bot.id])}
            onToggle={() =>
              setExpandedBots((current) => ({
                ...current,
                [bot.id]: !current[bot.id],
              }))
            }
          />
        ))}
      </div>
    </div>
  );
}
