"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
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
import { cn } from "@/lib/utils";
import type { BullpenPositionsResponse } from "@/lib/bullpenPositions";
import {
  buildBullpenAiAutoLiveSummary,
  buildBullpenAiTradingBotSummary,
  buildPolymarketTradingBotSummary,
  buildUnavailableTradingBotSummary,
  mergeTradingBotsOverview,
  normalizeTradingBotsOverviewResponse,
  sortTradingBots,
  type TradingBotGuardrail,
  type TradingBotSummary,
  type TradingBotsOverview,
} from "@/lib/tradingBots";
import { APIError, apiService } from "@/services/api";

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
    minimumFractionDigits: value >= 1000 ? 0 : 2,
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

async function fetchBullpenAiPositions() {
  const response = await fetch("/api/bullpen-ai/positions", {
    cache: "no-store",
  });
  const payload = (await response.json()) as BullpenPositionsResponse;

  if (!response.ok) {
    throw new Error(
      payload.error || "Unable to load Bullpen x AI position data right now.",
    );
  }

  return payload;
}

function buildFallbackOverviewFromError(error: string): TradingBotsOverview {
  return {
    generatedAt: new Date().toISOString(),
    bots: sortTradingBots([
      buildUnavailableTradingBotSummary("bullpen-x-polymarket", error),
      buildUnavailableTradingBotSummary("polymarket-direct", error),
      buildBullpenAiTradingBotSummary(null, error),
      buildBullpenAiAutoLiveSummary(),
    ]),
  };
}

async function loadFallbackOverview(): Promise<TradingBotsOverview> {
  const [polymarketResult, directResult, bullpenAiResult] = await Promise.allSettled([
    apiService.polymarketState(),
    apiService.polymarketDirectState(),
    fetchBullpenAiPositions(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    bots: sortTradingBots([
      polymarketResult.status === "fulfilled"
        ? buildPolymarketTradingBotSummary(
            "bullpen-x-polymarket",
            polymarketResult.value,
          )
        : buildUnavailableTradingBotSummary(
            "bullpen-x-polymarket",
            normalizeError(polymarketResult.reason),
          ),
      directResult.status === "fulfilled"
        ? buildPolymarketTradingBotSummary(
            "polymarket-direct",
            directResult.value,
          )
        : buildUnavailableTradingBotSummary(
            "polymarket-direct",
            normalizeError(directResult.reason),
          ),
      bullpenAiResult.status === "fulfilled"
        ? buildBullpenAiTradingBotSummary(bullpenAiResult.value)
        : buildBullpenAiTradingBotSummary(
            null,
            normalizeError(bullpenAiResult.reason),
          ),
      buildBullpenAiAutoLiveSummary(),
    ]),
  };
}

async function loadTradingBotsOverview(): Promise<{
  overview: TradingBotsOverview;
  usingFallback: boolean;
  error: string | null;
}> {
  const [preferredResult, fallbackResult] = await Promise.allSettled([
    apiService.getTradingBotsOverview(),
    loadFallbackOverview(),
  ]);

  const fallbackOverview =
    fallbackResult.status === "fulfilled"
      ? fallbackResult.value
      : buildFallbackOverviewFromError(normalizeError(fallbackResult.reason));

  const preferredOverview =
    preferredResult.status === "fulfilled"
      ? normalizeTradingBotsOverviewResponse(preferredResult.value)
      : null;
  const mergedOverview = mergeTradingBotsOverview(
    preferredOverview,
    fallbackOverview,
  );

  return {
    overview: mergedOverview,
    usingFallback: mergedOverview.bots.some((bot) => bot.source !== "api"),
    error:
      preferredResult.status === "rejected"
        ? getDisplayableOverviewError(preferredResult.reason)
        : fallbackResult.status === "rejected"
          ? normalizeError(fallbackResult.reason)
          : null,
  };
}

function TradingBotCard({
  bot,
  expanded,
  onToggle,
}: {
  bot: TradingBotSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const profitTone =
    bot.profitLoss == null
      ? "text-slate-700"
      : bot.profitLoss >= 0
        ? "text-emerald-700"
        : "text-rose-700";
  const statItems = [
    { label: "Money invested", value: formatMoney(bot.moneyInvested) },
    { label: "Current value", value: formatMoney(bot.currentValue) },
    {
      label: "Profit/Loss",
      value: formatMoney(bot.profitLoss),
      valueClassName: profitTone,
    },
    {
      label: "Return %",
      value: formatPercent(bot.returnPct),
      valueClassName: profitTone,
    },
    {
      label: "Active positions",
      value: formatCount(bot.activePositionsCount),
    },
    { label: "Trades today", value: formatCount(bot.tradesToday) },
    { label: "Last run", value: formatDateTime(bot.lastRunTime) },
    { label: "Next scheduled", value: formatDateTime(bot.nextScheduledRun) },
  ];

  return (
    <Card className="gap-0 rounded-[28px] border border-slate-200 bg-white py-0 shadow-sm">
      <CardHeader className="gap-4 border-b border-slate-100 px-6 py-6 sm:px-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
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
            <CardDescription className="max-w-3xl text-sm text-slate-600">
              {bot.strategy}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              asChild
              size="sm"
              className="rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
            >
              <Link href={bot.href}>Open Bot</Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onToggle}
              className="rounded-full border-slate-300 px-5"
            >
              {expanded ? "Hide Details" : "View Details"}
              {expanded ? (
                <ChevronUp className="ml-2 size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="ml-2 size-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-6 py-6 sm:px-7">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {statItems.map((item) => (
            <div
              key={item.label}
              className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3"
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

        <div className="space-y-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Basic guardrails summary
            </p>
            <p className="mt-2 text-sm text-slate-700">{bot.guardrailsSummary}</p>
          </div>
          <div className="rounded-2xl border border-rose-100 bg-rose-50/60 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
              Primary risk warning
            </p>
            <p className="mt-2 text-sm text-rose-800">{bot.riskWarning}</p>
          </div>
        </div>

        {expanded ? (
          <div className="grid gap-5 border-t border-slate-100 pt-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Strategy / Workflow
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  {bot.strategy}
                </p>
              </div>
              {bot.note ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  {bot.note}
                </div>
              ) : null}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Guardrails
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {bot.guardrails.map((guardrail) => (
                  <span
                    key={`${guardrail.label}-${guardrail.value}`}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium",
                      getGuardrailToneClass(guardrail.tone),
                    )}
                  >
                    {guardrail.label}: {guardrail.value}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TradingBotCardSkeleton() {
  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="h-5 w-48 animate-pulse rounded-full bg-slate-200" />
      <div className="mt-4 h-4 w-4/5 animate-pulse rounded-full bg-slate-100" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
          />
        ))}
      </div>
    </div>
  );
}

export function TradingBotsOverviewPage() {
  const [overview, setOverview] = useState<TradingBotsOverview | null>(null);
  const [expandedBots, setExpandedBots] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [usingFallback, setUsingFallback] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refreshOverview({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) {
      setIsRefreshing(true);
    }

    try {
      const next = await loadTradingBotsOverview();
      setOverview(next.overview);
      setUsingFallback(next.usingFallback);
      setLoadError(next.error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const next = await loadTradingBotsOverview();
        if (cancelled) return;

        setOverview(next.overview);
        setUsingFallback(next.usingFallback);
        setLoadError(next.error);
      } catch (error) {
        if (cancelled) return;

        const fallbackError = normalizeError(error);
        setOverview(buildFallbackOverviewFromError(fallbackError));
        setUsingFallback(true);
        setLoadError(fallbackError);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const bots = overview?.bots || [];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 pb-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-3">
          <div className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Trading Bots
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950">
              Bot Overview
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Review the current status, capital posture, guardrails, and workflow for every trading bot from one shared console screen without changing any existing bot URL.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs text-slate-500 shadow-sm">
            Last refreshed {formatDateTime(overview?.generatedAt || null)}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshOverview()}
            disabled={isRefreshing}
            className="rounded-full border-slate-300 px-5"
          >
            <RefreshCw
              className={cn("mr-2 size-3.5", isRefreshing ? "animate-spin" : "")}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      {usingFallback ? (
        <div className="flex items-start gap-3 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            This overview is already wired for a shared backend summary endpoint. Until that endpoint is fully available, it blends the current bot state APIs with safe placeholders where needed.
          </p>
        </div>
      ) : null}

      {loadError && !isLoading ? (
        <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Some bot summary data is unavailable right now: {loadError}
        </div>
      ) : null}

      <div className="grid gap-5">
        {isLoading
          ? Array.from({ length: 4 }).map((_, index) => (
              <TradingBotCardSkeleton key={index} />
            ))
          : bots.map((bot) => (
              <TradingBotCard
                key={bot.id}
                bot={bot}
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
