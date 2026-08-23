export type DashboardPortfolioTotal = {
  portfolioValue: number | null;
  cashValue: number | null;
  totalValue: number | null;
};

function finiteValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

export function resolvePortfolioPlusCash({
  portfolioValue,
  cashValue,
}: {
  portfolioValue: number | null | undefined;
  cashValue: number | null | undefined;
}): DashboardPortfolioTotal {
  const portfolio = finiteValue(portfolioValue);
  const cash = finiteValue(cashValue);
  return {
    portfolioValue: portfolio,
    cashValue: cash,
    totalValue:
      portfolio === null && cash === null
        ? null
        : roundMoney((portfolio ?? 0) + (cash ?? 0)),
  };
}

/**
 * Bullpen wallet_value/account_value may already include cash. Prefer the
 * independently verified positions + cash components when available and use
 * walletValue only as a total-value fallback, never as a position component.
 */
export function resolveBullpenPortfolioPlusCash({
  positionsValue,
  cashValue,
  walletValue,
}: {
  positionsValue: number | null | undefined;
  cashValue: number | null | undefined;
  walletValue: number | null | undefined;
}): DashboardPortfolioTotal {
  const positions = finiteValue(positionsValue);
  const cash = finiteValue(cashValue);
  const wallet = finiteValue(walletValue);

  if (positions !== null) {
    return {
      portfolioValue: positions,
      cashValue: cash,
      totalValue:
        cash !== null
          ? roundMoney(positions + cash)
          : wallet !== null
            ? wallet
            : positions,
    };
  }

  if (wallet !== null) {
    return {
      portfolioValue:
        cash !== null ? roundMoney(Math.max(0, wallet - cash)) : wallet,
      cashValue: cash,
      totalValue: wallet,
    };
  }

  return resolvePortfolioPlusCash({ portfolioValue: null, cashValue: cash });
}

export function convertDashboardUsdTotalToInr(
  total: DashboardPortfolioTotal,
  usdInrRate: number | null | undefined,
): DashboardPortfolioTotal {
  const rate = finiteValue(usdInrRate);
  if (rate === null || rate <= 0) {
    return { portfolioValue: null, cashValue: null, totalValue: null };
  }
  const convert = (value: number | null) =>
    value === null ? null : roundMoney(value * rate);
  return {
    portfolioValue: convert(total.portfolioValue),
    cashValue: convert(total.cashValue),
    totalValue: convert(total.totalValue),
  };
}
