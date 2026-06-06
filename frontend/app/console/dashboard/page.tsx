"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type {
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsThreatAnalysis,
  ZerodhaPortfolioOverviewResponse,
  ZerodhaStatusResponse,
  ZerodhaThreatAnalysis,
} from "@/types/api";

import { DashboardFinalActionablesTables } from "@/app/console/_components/FinalActionablesConsole";
import {
  MarketPortfolioCard,
  type PortfolioCardTopHolding,
} from "./_components/MarketPortfolioCard";
import { ThreatMarketCard } from "./_components/ThreatMarketCard";
import { RebalanceWorkflowSections } from "./_components/RebalanceWorkflowSections";
import {
  countThreatSeverities,
  extractUrgentActionRows,
  formatInr,
  formatPercent,
  formatSnapshotDate,
  formatSnapshotTime,
  formatTs,
  getThreatSummaryPoints,
  normalizeError,
  sortUrgentActionRows,
  toneClass,
} from "./_components/dashboardOverviewUtils";

type DashboardState = {
  zerodhaStatus: ZerodhaStatusResponse | null;
  zerodhaOverview: ZerodhaPortfolioOverviewResponse | null;
  zerodhaThreat: ZerodhaThreatAnalysis | null;
  indmoneyOverview: IndMoneyUsPortfolioOverviewResponse | null;
  indmoneyThreat: IndMoneyUsThreatAnalysis | null;
};

const INITIAL_STATE: DashboardState = {
  zerodhaStatus: null,
  zerodhaOverview: null,
  zerodhaThreat: null,
  indmoneyOverview: null,
  indmoneyThreat: null,
};

function buildIndiaTopHoldings(
  overview: ZerodhaPortfolioOverviewResponse | null,
): PortfolioCardTopHolding[] {
  const holdings = [...(overview?.latest?.holdings ?? [])]
    .sort((left, right) => right.market_value - left.market_value)
    .slice(0, 4);

  return holdings.map((holding) => ({
    id: `${holding.exchange}-${holding.tradingsymbol}`,
    symbol: holding.tradingsymbol,
    exchange: holding.exchange,
    value: formatInr(holding.market_value),
    secondaryValue: `P&L ${formatInr(holding.pnl)}`,
    secondaryToneClass: toneClass(holding.pnl),
  }));
}

type SnapshotMarket = "india" | "us";
type SnapshotPillTone = "success" | "warning" | "danger";

const MARKET_SESSIONS: Record<
  SnapshotMarket,
  { timeZone: string; openMinutes: number; closeMinutes: number }
> = {
  india: {
    timeZone: "Asia/Kolkata",
    openMinutes: 9 * 60 + 15,
    closeMinutes: 15 * 60 + 30,
  },
  us: {
    timeZone: "America/New_York",
    openMinutes: 9 * 60 + 30,
    closeMinutes: 16 * 60,
  },
};

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

function getTimeZoneOffsetMs(utcDate: Date, timeZone: string) {
  const parts = getZonedParts(utcDate, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtc - utcDate.getTime();
}

function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const approximateUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMs = getTimeZoneOffsetMs(approximateUtc, timeZone);
  return new Date(approximateUtc.getTime() - offsetMs);
}

function isWeekday(weekday: string) {
  return weekday !== "Sat" && weekday !== "Sun";
}

function getPreviousMarketClose(now: Date, market: SnapshotMarket) {
  const session = MARKET_SESSIONS[market];
  const parts = getZonedParts(now, session.timeZone);
  const localMinutes = parts.hour * 60 + parts.minute;
  const todayClose = zonedTimeToUtc(
    session.timeZone,
    parts.year,
    parts.month,
    parts.day,
    Math.floor(session.closeMinutes / 60),
    session.closeMinutes % 60,
  );

  if (isWeekday(parts.weekday) && localMinutes >= session.closeMinutes) {
    return todayClose;
  }

  for (let daysBack = 1; daysBack <= 7; daysBack += 1) {
    const candidate = new Date(todayClose);
    candidate.setUTCDate(candidate.getUTCDate() - daysBack);
    const candidateParts = getZonedParts(candidate, session.timeZone);
    if (isWeekday(candidateParts.weekday)) {
      return zonedTimeToUtc(
        session.timeZone,
        candidateParts.year,
        candidateParts.month,
        candidateParts.day,
        Math.floor(session.closeMinutes / 60),
        session.closeMinutes % 60,
      );
    }
  }

  return todayClose;
}

function isMarketOpen(now: Date, market: SnapshotMarket) {
  const session = MARKET_SESSIONS[market];
  const parts = getZonedParts(now, session.timeZone);
  if (!isWeekday(parts.weekday)) return false;
  const localMinutes = parts.hour * 60 + parts.minute;
  return (
    localMinutes >= session.openMinutes && localMinutes < session.closeMinutes
  );
}

function getSnapshotPillTone(
  capturedAt: string | null | undefined,
  market: SnapshotMarket,
): SnapshotPillTone {
  if (!capturedAt) return "danger";
  const now = new Date();
  if (isMarketOpen(now, market)) return "warning";

  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return "danger";

  return capturedMs >= getPreviousMarketClose(now, market).getTime()
    ? "success"
    : "danger";
}

function formatUsdValueAsInr(
  value: number | null | undefined,
  usdInrRate: number,
) {
  if (value == null) return formatInr(value);
  return formatInr(value * usdInrRate);
}

function PortfolioCommandSummary({
  totalValue,
  zerodhaValue,
  zerodhaPortfolioValue,
  zerodhaMargin,
  indmoneyPortfolioValue,
  indmoneyFundsValue,
}: {
  totalValue: number;
  zerodhaValue: number;
  zerodhaPortfolioValue: number | null | undefined;
  zerodhaMargin: number;
  indmoneyPortfolioValue: number | null | undefined;
  indmoneyFundsValue: number | null | undefined;
}) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-white/8 p-5 shadow-2xl shadow-slate-950/15 backdrop-blur">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
        <div className="min-w-[210px] flex-1">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">
            <Target className="size-3.5" />
            Total Investments
          </div>
          <div className="mt-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
            {formatInr(totalValue)}
          </div>
        </div>

        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <div className="rounded-[18px] border border-white/10 bg-white/8 px-4 py-4 text-slate-200">
            <div className="text-xs font-semibold text-white">Zerodha</div>
            <div className="mt-1 text-sm font-bold text-white">
              {formatInr(zerodhaValue)}
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-200">
              {formatInr(zerodhaPortfolioValue)} portfolio +{" "}
              {formatInr(zerodhaMargin)} margin
            </div>
          </div>

          <div className="rounded-[18px] border border-white/10 bg-white/8 px-4 py-4 text-slate-200">
            <div className="text-xs font-semibold text-white">INDmoney</div>
            <div className="mt-1 text-sm font-bold text-white">
              {formatInr(indmoneyPortfolioValue)}
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-200">
              {formatInr(indmoneyPortfolioValue)} total portfolio +{" "}
              {formatInr(indmoneyFundsValue)} available funds
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildUsTopHoldings(
  overview: IndMoneyUsPortfolioOverviewResponse | null,
  usdInrRate: number,
): PortfolioCardTopHolding[] {
  const topAllocations = overview?.latest?.derived.top_allocations ?? [];
  const holdings =
    topAllocations.length > 0
      ? topAllocations.slice(0, 4)
      : [...(overview?.latest?.holdings ?? [])]
          .sort(
            (left, right) =>
              (right.current_value ?? 0) - (left.current_value ?? 0),
          )
          .slice(0, 4);

  return holdings.map((holding) => ({
    id: holding.symbol,
    symbol: holding.symbol,
    value: formatUsdValueAsInr(holding.current_value, usdInrRate),
    name: holding.company_name,
    secondaryValue: `P&L ${formatPercent(holding.total_pnl_percent)}`,
    secondaryToneClass: toneClass(holding.total_pnl_percent),
  }));
}

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<DashboardState>(INITIAL_STATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const usdInrRate = useUsdInrRate();

  const loadDashboard = useCallback(async (initialLoad = false) => {
    if (initialLoad) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    const results = await Promise.allSettled([
      apiService.zerodhaStatus(),
      apiService.zerodhaPortfolioOverview(),
      apiService.zerodhaThreatsLatest(),
      apiService.indmoneyUsPortfolioOverview(),
      apiService.indmoneyUsThreatsLatest(),
    ] as const);

    const nextErrors: string[] = [];

    setDashboard((current) => {
      const nextState = { ...current };

      if (results[0].status === "fulfilled") {
        nextState.zerodhaStatus = results[0].value;
      } else {
        nextErrors.push(
          `India connection status: ${normalizeError(results[0].reason)}`,
        );
      }

      if (results[1].status === "fulfilled") {
        nextState.zerodhaOverview = results[1].value;
      } else {
        nextErrors.push(
          `India portfolio: ${normalizeError(results[1].reason)}`,
        );
      }

      if (results[2].status === "fulfilled") {
        nextState.zerodhaThreat = results[2].value.analysis;
      } else {
        nextErrors.push(`India threats: ${normalizeError(results[2].reason)}`);
      }

      if (results[3].status === "fulfilled") {
        nextState.indmoneyOverview = results[3].value;
      } else {
        nextErrors.push(`US portfolio: ${normalizeError(results[3].reason)}`);
      }

      if (results[4].status === "fulfilled") {
        nextState.indmoneyThreat = results[4].value.analysis;
      } else {
        nextErrors.push(`US threats: ${normalizeError(results[4].reason)}`);
      }

      return nextState;
    });

    setErrors(nextErrors);
    if (initialLoad) {
      setLoading(false);
    } else {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadDashboard(true);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadDashboard]);

  const indiaSnapshot = dashboard.zerodhaOverview?.latest ?? null;
  const usSnapshot = dashboard.indmoneyOverview?.latest ?? null;
  const indiaSnapshotTone = getSnapshotPillTone(
    indiaSnapshot?.captured_at,
    "india",
  );
  const usSnapshotTone = getSnapshotPillTone(usSnapshot?.captured_at, "us");
  const indiaUrgentRows = sortUrgentActionRows(
    extractUrgentActionRows({
      analysis: dashboard.zerodhaThreat,
      market: "india",
      threatHref: URLs.routes.console.zerodhaThreats(),
    }),
  );
  const usUrgentRows = sortUrgentActionRows(
    extractUrgentActionRows({
      analysis: dashboard.indmoneyThreat,
      market: "us",
      threatHref: URLs.routes.console.indmoneyUsThreats(),
    }),
  );
  const zerodhaInvestedValue = (indiaSnapshot?.holdings ?? []).reduce(
    (sum, holding) => sum + (holding.invested_value || 0),
    0,
  );
  const zerodhaAvailableMargin = indiaSnapshot?.available_margin ?? 0;
  const zerodhaCommandValue =
    (indiaSnapshot?.holdings_market_value ?? 0) + zerodhaAvailableMargin;
  const indmoneyInvestedValue = usSnapshot?.invested_value ?? 0;
  const indmoneyPortfolioValueInr =
    usSnapshot?.current_value == null
      ? undefined
      : usSnapshot.current_value * usdInrRate;
  const indmoneyAvailableFundsValueInr =
    usSnapshot?.wallet_balance == null
      ? undefined
      : usSnapshot.wallet_balance * usdInrRate;
  const indmoneyCommandValue = indmoneyPortfolioValueInr ?? 0;
  const totalCommandValue = zerodhaCommandValue + indmoneyCommandValue;
  const indmoneyAvailableFunds = usSnapshot?.wallet_balance ?? 0;
  if (
    loading &&
    !indiaSnapshot &&
    !usSnapshot &&
    !dashboard.zerodhaThreat &&
    !dashboard.indmoneyThreat
  ) {
    return (
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Loading investor dashboard...
      </div>
    );
  }

  return (
    <div className="mx-auto flex flex-col gap-6">
      <section className="relative overflow-hidden rounded-[36px] border border-slate-200 bg-linear-to-br from-slate-950 via-slate-900 to-slate-800 text-white shadow-lg">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.22),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.22),_transparent_35%)]" />

        <div className="relative grid gap-6 px-6 py-7 lg:grid-cols-[minmax(0,1fr)_minmax(460px,0.95fr)] lg:items-center lg:px-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100">
              <Sparkles className="size-3.5" />
              Investments Control Room
            </div>
            <h1 className="mt-4 max-w-3xl font-serif text-3xl tracking-tight text-white md:text-4xl">
              Portfolio Command Center
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-200/90">
              The dashboard is centered on real portfolio intelligence: India
              and INDmoney US portfolios up front, followed by the five final
              actionable decision tables.
            </p>

            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                onClick={() => void loadDashboard(false)}
                disabled={refreshing}
                className="rounded-full bg-amber-400 text-slate-950 hover:bg-amber-300"
              >
                {refreshing ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 size-4" />
                )}
                Refresh Board
              </Button>
            </div>
          </div>

          <PortfolioCommandSummary
            totalValue={totalCommandValue}
            zerodhaValue={zerodhaCommandValue}
            zerodhaPortfolioValue={indiaSnapshot?.holdings_market_value}
            zerodhaMargin={zerodhaAvailableMargin}
            indmoneyPortfolioValue={indmoneyPortfolioValueInr}
            indmoneyFundsValue={indmoneyAvailableFundsValueInr}
          />
        </div>
      </section>

      {errors.length > 0 ? (
        <div className="flex items-start gap-3 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            Some dashboard modules could not be refreshed: {errors.join(" | ")}
          </span>
        </div>
      ) : null}

      <RebalanceWorkflowSections
        onDashboardRefresh={() => loadDashboard(false)}
      />

      <section className="grid gap-6 xl:grid-cols-2">
        <MarketPortfolioCard
          market="india"
          title="Zerodha India"
          description="Live broker-backed holdings, P&L, and top concentration pockets from your latest synced India book."
          statusPills={[
            {
              label: "Connection",
              value: dashboard.zerodhaStatus?.connected
                ? "Connected"
                : "Disconnected",
              tone: dashboard.zerodhaStatus?.connected ? "success" : "danger",
            },
            {
              label: "Snapshot",
              value: indiaSnapshot
                ? formatSnapshotDate(indiaSnapshot.snapshot_date)
                : "Missing",
              detail: indiaSnapshot
                ? formatSnapshotTime(indiaSnapshot.captured_at)
                : undefined,
              tone: indiaSnapshot ? indiaSnapshotTone : "danger",
            },
          ]}
          metrics={[
            {
              label: "Invested Amount",
              value: formatInr(zerodhaInvestedValue),
              detail: `Holdings value ${formatInr(indiaSnapshot?.holdings_market_value)}`,
            },
            {
              label: "Unrealized P&L",
              value: formatInr(indiaSnapshot?.holdings_pnl),
              tone:
                (indiaSnapshot?.holdings_pnl ?? 0) >= 0
                  ? "positive"
                  : "negative",
            },
            {
              label: "Day Change",
              value: formatInr(indiaSnapshot?.holdings_day_change_value),
              tone:
                (indiaSnapshot?.holdings_day_change_value ?? 0) >= 0
                  ? "positive"
                  : "negative",
            },
            {
              label: "Available Margin",
              value: formatInr(zerodhaAvailableMargin),
              detail: indiaSnapshot
                ? `Captured ${formatTs(indiaSnapshot.captured_at)}`
                : "No synced snapshot yet",
            },
          ]}
          topHoldings={buildIndiaTopHoldings(dashboard.zerodhaOverview)}
          portfolioHref={URLs.routes.console.zerodha()}
          threatsHref={URLs.routes.console.zerodhaThreats()}
          actionLinks={[
            {
              label: "Portfolio",
              href: URLs.routes.console.zerodha(),
              primary: true,
            },
            {
              label: "Threat Radar",
              href: URLs.routes.console.zerodhaThreats(),
            },
            {
              label: "Swing Trade",
              href: URLs.routes.console.zerodhaSwingTrade(),
            },
            { label: "Events", href: URLs.routes.console.zerodhaEvents() },
            {
              label: "Rebalance",
              href: URLs.routes.console.zerodhaRebalance(),
            },
            {
              label: "Final Actionables",
              href: URLs.routes.console.zerodhaFinalActionables(),
            },
          ]}
          emptyMessage={
            indiaSnapshot
              ? null
              : "Connect Zerodha and sync at least one snapshot to unlock India portfolio cards and threat prioritization here."
          }
        />

        <MarketPortfolioCard
          market="us"
          title="INDmoney US"
          description="Manual US snapshot tracking, top allocations, and return posture for the INDmoney portfolio."
          statusPills={[
            {
              label: "Parse",
              value: usSnapshot?.parse_status ?? "Missing",
              tone:
                usSnapshot?.parse_status?.toLowerCase() === "parsed"
                  ? "success"
                  : "danger",
            },
            {
              label: "Snapshot",
              value: usSnapshot
                ? formatSnapshotDate(usSnapshot.snapshot_date)
                : "Missing",
              detail: usSnapshot
                ? formatSnapshotTime(usSnapshot.captured_at)
                : undefined,
              tone: usSnapshot ? usSnapshotTone : "danger",
            },
          ]}
          metrics={[
            {
              label: "Invested Amount",
              value: formatUsdValueAsInr(indmoneyInvestedValue, usdInrRate),
              detail: `Current value ${formatUsdValueAsInr(
                usSnapshot?.current_value,
                usdInrRate,
              )}`,
            },
            {
              label: "Total Return",
              value: formatUsdValueAsInr(
                usSnapshot?.total_return_value,
                usdInrRate,
              ),
              tone:
                (usSnapshot?.total_return_value ?? 0) >= 0
                  ? "positive"
                  : "negative",
            },
            {
              label: "Day Return",
              value: formatUsdValueAsInr(
                usSnapshot?.day_return_value,
                usdInrRate,
              ),
              tone:
                (usSnapshot?.day_return_value ?? 0) >= 0
                  ? "positive"
                  : "negative",
            },
            {
              label: "Available Funds",
              value: formatUsdValueAsInr(indmoneyAvailableFunds, usdInrRate),
              detail: usSnapshot
                ? `Captured ${formatTs(usSnapshot.captured_at)}`
                : "No pasted snapshot yet",
            },
          ]}
          topHoldings={buildUsTopHoldings(
            dashboard.indmoneyOverview,
            usdInrRate,
          )}
          portfolioHref={URLs.routes.console.indmoneyUs()}
          threatsHref={URLs.routes.console.indmoneyUsThreats()}
          actionLinks={[
            {
              label: "Portfolio",
              href: URLs.routes.console.indmoneyUs(),
              primary: true,
            },
            {
              label: "Threat Radar",
              href: URLs.routes.console.indmoneyUsThreats(),
            },
            {
              label: "Swing Trade",
              href: URLs.routes.console.indmoneyUsSwingTrade(),
            },
            { label: "Events", href: URLs.routes.console.indmoneyUsEvents() },
            {
              label: "Rebalance",
              href: URLs.routes.console.indmoneyUsRebalance(),
            },
            {
              label: "Final Actionables",
              href: URLs.routes.console.indmoneyUsFinalActionables(),
            },
          ]}
          emptyMessage={
            usSnapshot
              ? null
              : "Paste an INDmoney US snapshot to surface allocations, return metrics, and threat signals on the dashboard."
          }
        />
      </section>

      <DashboardFinalActionablesTables />

      <section className="grid gap-6 xl:grid-cols-2">
        <ThreatMarketCard
          market="india"
          title="India Threat Pulse"
          description="Summary of the most important downside signals, protection cues, and severity mix from the latest India threat scan."
          summaryPoints={getThreatSummaryPoints(dashboard.zerodhaThreat)}
          severityCounts={countThreatSeverities(
            dashboard.zerodhaThreat?.report?.tables,
          )}
          urgentActionCount={indiaUrgentRows.length}
          lastUpdated={formatTs(dashboard.zerodhaThreat?.updated_at)}
          href={URLs.routes.console.zerodhaThreats()}
          emptyMessage={
            dashboard.zerodhaThreat?.report
              ? null
              : indiaSnapshot
                ? "Run a Zerodha threat scan to populate Table 10 actionables and the India severity pulse."
                : "Threat insights will appear here after your first India portfolio sync."
          }
        />

        <ThreatMarketCard
          market="us"
          title="US Threat Pulse"
          description="Quick read on crowded winners, event risk, and capital-protection ideas from the latest INDmoney US threat radar."
          summaryPoints={getThreatSummaryPoints(dashboard.indmoneyThreat)}
          severityCounts={countThreatSeverities(
            dashboard.indmoneyThreat?.report?.tables,
          )}
          urgentActionCount={usUrgentRows.length}
          lastUpdated={formatTs(dashboard.indmoneyThreat?.updated_at)}
          href={URLs.routes.console.indmoneyUsThreats()}
          emptyMessage={
            dashboard.indmoneyThreat?.report
              ? null
              : usSnapshot
                ? "Run the INDmoney US threat scan to surface Table 10 actionables on the dashboard."
                : "Threat insights will appear here after your first INDmoney US snapshot."
          }
        />
      </section>
    </div>
  );
}
