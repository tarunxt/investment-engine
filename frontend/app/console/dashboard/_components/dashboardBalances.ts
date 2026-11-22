import type {
  DashboardSummaryResponse,
  IndMoneyUsPortfolioOverviewResponse,
  ZerodhaPortfolioOverviewResponse,
} from "@/types/api";
import type { SidebarPolicy } from "@/lib/sidebarVisibility";
import {
  isUsableBullpenPositionsSnapshot,
  sumCurrentPositionValue,
  type BullpenPositionsResponse,
} from "@/lib/bullpenPositions";
import {
  isBullpenHistoryActivePosition,
  isBullpenHistoryClaimablePosition,
} from "@/lib/bullpenHistoryPositions";

export type Source = "zerodha" | "indmoney" | "bullpen";
export type Fx = DashboardSummaryResponse["fx"];
export type Amount = { value: number; at: string };
export type Balance = {
  portfolio: Amount | null;
  cash: Amount | null;
  wallet: Amount | null;
};
export const emptyBalance: Balance = {
  portfolio: null,
  cash: null,
  wallet: null,
};
export const labels = {
  zerodha: "Zerodha",
  indmoney: "INDmoney",
  bullpen: "Bullpen",
};

export function visibleSources(
  policy: SidebarPolicy | null | undefined,
  role: string,
): Source[] {
  if (!policy) return [];
  const ids = policy.visible_ids;
  const result: Source[] = [];
  if (!ids || ids.includes("india-portfolio")) result.push("zerodha");
  if (!ids || ids.includes("us-portfolio")) result.push("indmoney");
  if (role === "admin" && (!ids || ids.some((id) => id.startsWith("bullpen"))))
    result.push("bullpen");
  return result;
}

function amount(value: unknown, at: unknown): Amount | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    typeof at === "string" &&
    Number.isFinite(Date.parse(at))
    ? { value, at }
    : null;
}

function latest(a: Amount | null, b: Amount | null) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.at) >= Date.parse(a.at) ? b : a;
}

export function mergeBalances(previous: Balance, next: Balance): Balance {
  return {
    portfolio: latest(previous.portfolio, next.portfolio),
    cash: latest(previous.cash, next.cash),
    wallet: latest(previous.wallet, next.wallet),
  };
}

export function balanceTotal(balance: Balance) {
  const { portfolio, cash, wallet } = balance;
  if (
    wallet &&
    (!portfolio ||
      !cash ||
      Date.parse(wallet.at) >
        Math.max(Date.parse(portfolio.at), Date.parse(cash.at)))
  )
    return wallet.value;
  return portfolio && cash ? portfolio.value + cash.value : null;
}

export function indiaBalance(overview: ZerodhaPortfolioOverviewResponse) {
  let result = emptyBalance;
  for (const row of [...overview.history, overview.latest]) {
    if (row)
      result = mergeBalances(result, {
        portfolio: amount(row.holdings_market_value, row.captured_at),
        cash: amount(row.available_margin, row.captured_at),
        wallet: null,
      });
  }
  return result;
}

export function usBalance(overview: IndMoneyUsPortfolioOverviewResponse) {
  let result = emptyBalance;
  for (const row of [...overview.history, overview.latest]) {
    if (row)
      result = mergeBalances(result, {
        portfolio: amount(row.current_value, row.captured_at),
        cash: amount(row.wallet_balance, row.captured_at),
        wallet: null,
      });
  }
  const detail = overview.latest;
  if (
    detail &&
    detail.current_value == null &&
    detail.holdings?.length > 0 &&
    detail.holdings.length ===
      (detail.reported_holdings_count ?? detail.holdings_count) &&
    detail.holdings.every((h) => Number.isFinite(h.current_value))
  ) {
    result = mergeBalances(result, {
      ...emptyBalance,
      portfolio: amount(
        detail.derived.parsed_holdings_current_value,
        detail.captured_at,
      ),
    });
  }
  return result;
}

export function bullpenBalance(snapshot: BullpenPositionsResponse): Balance {
  if (
    !isUsableBullpenPositionsSnapshot({
      positionsSource: snapshot.positionsSource,
      liveAvailable: snapshot.liveAvailable,
    })
  )
    return emptyBalance;
  const at =
    snapshot.fetchedAt ?? snapshot.lastSuccessfulLiveSnapshot?.fetchedAt;
  const wallet = amount(
    snapshot.summary?.walletValue ?? snapshot.summary?.totalValue,
    at,
  );
  const cash = amount(snapshot.summary?.cashBalance, at);
  const rows = snapshot.positions;
  const positions = rows
    ? sumCurrentPositionValue(rows.filter(isBullpenHistoryActivePosition)) +
      rows
        .filter(isBullpenHistoryClaimablePosition)
        .reduce(
          (total, item) =>
            total +
            Math.max(
              0,
              item.claimableValue ??
                item.expectedPayoutUsd ??
                item.currentValue ??
                0,
            ),
          0,
        )
    : null;
  return {
    wallet,
    cash,
    portfolio: amount(
      positions ??
        (wallet && cash ? Math.max(0, wallet.value - cash.value) : null),
      at,
    ),
  };
}

function cacheKey(userId: number, source: Source) {
  return `investment-engine:dashboard-overview-cache:v4:user:${userId}:${source}`;
}

export function readBalance(userId: number, source: Source): Balance {
  try {
    const stored = JSON.parse(
      localStorage.getItem(cacheKey(userId, source)) ?? "null",
    );
    if (stored) {
      const field = (key: keyof Balance) =>
        amount(stored[key]?.value, stored[key]?.at);
      return {
        portfolio: field("portfolio"),
        cash: field("cash"),
        wallet: field("wallet"),
      };
    }
    const old = JSON.parse(
      localStorage.getItem(
        `investment-engine:dashboard-overview-cache:v3:user:${userId}`,
      ) ?? "null",
    );
    // Summary history in v3 used a combined amount as portfolio and an artificial zero for cash.
    // Only the original latest snapshot contains separately captured components.
    const key = {
      zerodha: "zerodhaOverview",
      indmoney: "indmoneyOverview",
      bullpen: "bullpenPositions",
    }[source];
    const value = old?.version === 2 && old.entries?.[key]?.value;
    if (value) {
      if (source === "bullpen") return bullpenBalance(value);
      return source === "zerodha"
        ? indiaBalance({ latest: value.latest, history: [] })
        : usBalance({ latest: value.latest, history: [] });
    }
  } catch {
    /* A blocked or invalid browser cache cannot prevent a portfolio read. */
  }
  return emptyBalance;
}

export function saveBalance(userId: number, source: Source, balance: Balance) {
  try {
    localStorage.setItem(
      cacheKey(userId, source),
      JSON.stringify(mergeBalances(readBalance(userId, source), balance)),
    );
  } catch {
    /* The current tab still has the balance. */
  }
}
