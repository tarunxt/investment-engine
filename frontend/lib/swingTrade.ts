export type SwingTradeMarket = 'india' | 'us';

const DEFAULT_INVESTMENT_AMOUNT: Record<SwingTradeMarket, string> = {
  india: '50,000',
  us: '100',
};

export type ZerodhaSwingSettings = {
  stockCount: string;
  investmentAmount: string;
  horizon: string;
};

export const DEFAULT_ZERODHA_SWING_SETTINGS: ZerodhaSwingSettings = {
  stockCount: '5',
  investmentAmount: DEFAULT_INVESTMENT_AMOUNT.india,
  horizon: '1–3 months',
};

export function validateZerodhaSwingSettings(draft: ZerodhaSwingSettings):
  { settings: ZerodhaSwingSettings; error?: undefined } | { settings?: undefined; error: string } {
  const count = draft.stockCount.trim();
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count) < 1) {
    return { error: 'Enter a whole number of stocks greater than zero.' };
  }
  const amount = draft.investmentAmount.trim().replace(/^(?:₹|inr|rs\.?)\s*/i, '');
  const rupees = Number(amount.replaceAll(',', ''));
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(amount)
    || !(rupees > 0) || rupees > Number.MAX_SAFE_INTEGER / 100) {
    return { error: 'Enter a positive rupee amount, such as 50,000.' };
  }
  const horizon = draft.horizon.trim();
  const range = /^(\d+(?:\.\d+)?)(?:\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?))?\s*((?:trading |calendar )?days?|weeks?|months?|years?)$/i.exec(horizon);
  if (!range || !Number.isFinite(Number(range[2] ?? range[1])) || Number(range[1]) <= 0 || Number(range[2] ?? range[1]) < Number(range[1])) {
    return { error: 'Enter a duration such as 10 days or 2–6 weeks, with the shorter duration first.' };
  }
  return { settings: {
    stockCount: String(Number(count)),
    investmentAmount: rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
    horizon,
  } };
}

export function readZerodhaSwingSettings(ownerId?: number): ZerodhaSwingSettings {
  if (ownerId && typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(zerodhaSwingSettingsKey(ownerId));
      if (raw) return validateZerodhaSwingSettings(JSON.parse(raw)).settings ?? DEFAULT_ZERODHA_SWING_SETTINGS;
    } catch { /* Missing or invalid settings use the original scan defaults. */ }
  }
  return DEFAULT_ZERODHA_SWING_SETTINGS;
}

export function zerodhaSwingSettingsKey(ownerId: number) {
  return `zerodha-swing-settings:${ownerId}`;
}

const EXPORT_SHEET_SUFFIX: Record<SwingTradeMarket, string> = {
  india: 'Ind',
  us: 'US',
};

const CURRENCY_CODE: Record<SwingTradeMarket, string> = {
  india: 'INR',
  us: 'USD',
};

const MARKET_TIMEZONE: Record<SwingTradeMarket, string> = {
  india: 'Asia/Kolkata',
  us: 'America/New_York',
};

function stripCurrencyPrefix(value: string) {
  return value
    .replace(/^(?:inr|usd|rs\.?|₹|\$)\s*/i, '')
    .replace(/\s*(?:inr|usd|rs\.?|₹|\$)$/i, '')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getSwingTradeCurrencyCode(market: SwingTradeMarket) {
  return CURRENCY_CODE[market];
}

export function getSwingTradeDefaultInvestmentAmount(market: SwingTradeMarket) {
  return DEFAULT_INVESTMENT_AMOUNT[market];
}

export function getSwingTradeDefaultExportSheetName(
  market: SwingTradeMarket,
  now = new Date(),
) {
  const dateLabel = now.toLocaleDateString('en-IN', {
    timeZone: MARKET_TIMEZONE[market],
    month: 'short',
    day: 'numeric',
  });
  return `${dateLabel} (${EXPORT_SHEET_SUFFIX[market]})`;
}

export function normalizeSwingTradeInvestmentAmount(
  market: SwingTradeMarket,
  rawAmount?: string | null,
) {
  const cleaned = stripCurrencyPrefix(rawAmount?.trim() ?? '');
  return cleaned || DEFAULT_INVESTMENT_AMOUNT[market];
}

export function buildSwingTradePrompt(
  market: SwingTradeMarket,
  rawInvestmentAmount?: string | null,
  selection?: Pick<ZerodhaSwingSettings, 'stockCount' | 'horizon'>,
) {
  const investmentAmount = normalizeSwingTradeInvestmentAmount(market, rawInvestmentAmount);
  const currencyCode = CURRENCY_CODE[market];
  const marketLabel = market === 'india' ? 'India' : 'US';

  const count = selection?.stockCount ?? DEFAULT_ZERODHA_SWING_SETTINGS.stockCount;
  const horizon = selection?.horizon ?? DEFAULT_ZERODHA_SWING_SETTINGS.horizon;
  // The worker accepts this stable alias and maps it back to the export column.
  const shortTermColumn = selection ? 'Rationale Technical Short Term' : 'Rationale Technical Setup Short Term 1–3 Months';

  return `Act as a top-tier ${marketLabel} aggressive swing-trading strategist combining the skills of a hedge fund trader, technical analyst, momentum screener, and sell-side strategist.

Objective:
Identify the BEST long aggressive swing-trade opportunities in ${marketLabel} equities right now for deploying exactly ${currencyCode} ${investmentAmount} today, targeting maximum returns over the next ${horizon}.

Use only fresh, recent, and credible market intelligence such as:
- Brokerage upgrades/downgrades
- Institutional research notes
- Earnings reactions
- CNBC/Bloomberg/Reuters interviews
- Verified X/Twitter commentary from respected traders/analysts
- Sector rotation trends
- Relative strength / momentum scans
- Price-volume breakout setups

Selection Rules:
1. Choose exactly ${count} ${count === '1' ? 'stock' : 'stocks'}.
2. Focus on liquid names only (high average volume, easy execution).
3. Prefer stocks showing:
   - breakout or pre-breakout structures
   - strong momentum with volume confirmation
   - accumulation after pullback
   - bullish catalysts/newsflow
   - sector tailwinds (AI, semis, fintech, biotech, energy, defense, etc.)
4. Avoid weak, illiquid, overextended, purely speculative, or low-conviction names.
5. Mix reward potential with probability of success.

Capital Allocation Rules:
- Total capital = ${currencyCode} ${investmentAmount} only
- Use fractional shares if needed
- Optimize for expected return, not diversification for its own sake

Analysis Method:
For each stock, evaluate:
- Trend strength
- Support/resistance
- Risk/reward ratio
- Catalyst strength
- Relative strength vs Index
- Volume behavior
- Probability of reaching target in ${selection ? horizon : '2–12 weeks'}

Output Rules:
${market === 'us' ? "Report the actual listing exchange for each security in Exchange Symbol (for example NASDAQ or NYSE). US is a market, not an exchange." : ""}
Return ONLY one markdown table.
No intro. No explanation. No notes. No disclaimer. No text before or after the table.

Title:
## [TODAY'S DATE] | How to Invest ${currencyCode} ${investmentAmount} | Generated by [This output is being generated by LLM Name + Model]

Table Columns:
| LLM Name + Model | Exchange Symbol | Stock Symbol | Stock Name | Technical Setup | Entry Range | Stop Loss | Target | Analyst Source | Units to Buy | Price per Unit | Total Buy Amount | Upside Horizon (%) | Weeks | Confidence Score (0-100) | Rationale Cruxx | Score Rationale Cruxx | Rationale - Technical Setup (Medium Term) | Score Rationale - Technical Setup (Medium Term) | Rationale - Technical Setup (Long Term) | Score Rationale - Technical Setup (Long Term) | Rationale - Fundamentals Short Term | Score Rationale - Fundamentals Short Term | Rationale - Fundamentals Medium/Long Term | Score Rationale - Fundamentals Medium/Long Term | ${shortTermColumn} | Score ${shortTermColumn} | Run # | Run Date | Run Time | LLM |

Formatting Rules:
- Rationale Score rule: every row MUST include a non-blank numeric value in every Score Rationale / rationale-score column. Use only one of these 7 integer choices: -3 (minus three)=very bearish, -2 (minus two)=bearish, -1 (minus one)=slightly bearish, 0=neutral, 1=slightly bullish, 2=bullish, 3=very bullish. Do not return blanks, dashes, N/A, decimals, ranges, percentages, words, or values outside these integers. Each rationale score must justify its adjacent rationale.
- Before finalizing the table, audit every Score Rationale cell; if any score is missing, infer the best -3 to 3 score from the adjacent rationale and fill it. A table with blank rationale scores is invalid.

- Use realistic current price zones
- Use concise professional wording
- Confidence score must reflect conviction + setup quality
- Use numeric-only values in cells for all numeric fields (no INR/% text in values)
- Upside Horizon should be numeric percent value only (example: 12.5)
- Weeks should be a numeric average of the expected lower/upper range (example: for 6-8 weeks, use 7)
- Units to Buy must mathematically fit ${currencyCode} ${investmentAmount} total
- Total Buy Amount must sum close to ${currencyCode} ${investmentAmount}
- Rank rows from highest conviction to lowest
- Use actionable numbers, not vague ranges`;
}

export function syncSwingTradePrompt(
  market: SwingTradeMarket,
  currentPrompt: string,
  previousInvestmentAmount: string,
  nextInvestmentAmount: string,
) {
  const currencyCode = CURRENCY_CODE[market];
  const previousAmount = normalizeSwingTradeInvestmentAmount(market, previousInvestmentAmount);
  const nextAmount = normalizeSwingTradeInvestmentAmount(market, nextInvestmentAmount);

  if (previousAmount === nextAmount) {
    return currentPrompt;
  }

  const pattern = new RegExp(
    escapeRegExp(`${currencyCode} ${previousAmount}`),
    'g',
  );

  return currentPrompt.replace(pattern, `${currencyCode} ${nextAmount}`);
}
