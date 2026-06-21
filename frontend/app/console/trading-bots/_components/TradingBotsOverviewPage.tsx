"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
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
  buildBullpenAiTradingBotSummary,
  buildPolymarketTradingBotSummary,
  buildTradingBotsOverviewShell,
  mergeTradingBotsOverview,
  normalizeTradingBotsOverviewResponse,
  type TradingBotGuardrail,
  type TradingBotSummary,
  type TradingBotsOverview,
} from "@/lib/tradingBots";
import { APIError, apiService } from "@/services/api";

const OVERVIEW_CACHE_KEY = "investor:trading-bots-overview:v1";
const PREFERRED_OVERVIEW_TIMEOUT_MS = 2_000;
const FAST_BOT_TIMEOUT_MS = 2_500;
const BULLPEN_AI_TIMEOUT_MS = 2_000;
const INITIAL_OVERVIEW = buildTradingBotsOverviewShell(
  "Loading latest trading bot status in the background.",
);

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

  window.sessionStorage.setItem(
    OVERVIEW_CACHE_KEY,
    JSON.stringify(overview),
  );
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

export function TradingBotsOverviewPage() {
  const [overview, setOverview] = useState<TradingBotsOverview>(INITIAL_OVERVIEW);
  const [expandedBots, setExpandedBots] = useState<Record<string, boolean>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingLatest, setIsLoadingLatest] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    writeCachedOverview(overview);
  }, [overview]);

  async function refreshOverview({
    includeBullpenAiPositions = false,
    silent = false,
  }: {
    includeBullpenAiPositions?: boolean;
    silent?: boolean;
  } = {}) {
    if (!silent) {
      setIsRefreshing(true);
    }

    setIsLoadingLatest(true);

    try {
      setLoadError(null);

      try {
        const preferredOverview = normalizeTradingBotsOverviewResponse(
          await withTimeout(
            apiService.getTradingBotsOverview(),
            PREFERRED_OVERVIEW_TIMEOUT_MS,
            "Trading Bots overview",
          ),
        );
        startTransition(() => {
          setOverview((current) =>
            mergeTradingBotsOverview(preferredOverview, current),
          );
        });
        return;
      } catch (error) {
        const displayableError = getDisplayableOverviewError(error);
        if (displayableError && !isTimeoutError(error)) {
          setLoadError(displayableError);
        }
      }

      const errors: string[] = [];
      const updates: Promise<void>[] = [
        withTimeout(
          apiService.polymarketState(),
          FAST_BOT_TIMEOUT_MS,
          "Bullpen x Polymarket state",
        )
          .then((state) => {
            startTransition(() => {
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
      ];

      if (includeBullpenAiPositions) {
        updates.push(
          fetchBullpenAiPositions()
            .then((payload) => {
              startTransition(() => {
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
        );
      }

      await Promise.allSettled(updates);

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
      void refreshOverview({ includeBullpenAiPositions: false, silent: true });
    }, 0);

    return () => window.clearTimeout(refreshTimer);
  }, []);

  const bots = overview.bots;
  const usingFallback = usesFallbackData(overview);

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
            onClick={() =>
              void refreshOverview({ includeBullpenAiPositions: true })
            }
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
            This overview now renders immediately with cached or placeholder cards first, then fills in live bot data in the background or on refresh where available.
          </p>
        </div>
      ) : null}

      {isLoadingLatest ? (
        <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Loading the latest bot status in the background. The page stays interactive while slower bot sources catch up.
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Some bot summary data is unavailable right now: {loadError}
        </div>
      ) : null}

      <div className="grid gap-5">
        {bots.map((bot) => (
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
