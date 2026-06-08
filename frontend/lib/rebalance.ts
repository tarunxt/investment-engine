import type {
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsThreatAnalysis,
  RunResponse,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaThreatAnalysis,
} from "@/types/api";
import type { SwingTradeMarket } from "@/lib/swingTrade";

export type RebalancePortfolioKey = "zerodha" | "indmoneyUs";

type PortfolioSnapshot =
  | ZerodhaPortfolioSnapshotDetail
  | IndMoneyUsPortfolioSnapshotDetail
  | null;
type ThreatAnalysis = ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis | null;

const SWING_COLUMN_LEGEND = [
  "LLM=LLM Name + Model",
  "Ex=Exchange Symbol",
  "Sym=Stock Symbol",
  "Name=Stock Name",
  "Setup=Technical Setup",
  "Entry=Entry Range",
  "SL=Stop Loss",
  "Tgt=Target",
  "Src=Analyst Source",
  "Units=Units to Buy",
  "Px=Price per Unit",
  "Amt=Total Buy Amount",
  "Upside=Upside Horizon (%)",
  "Wks=Weeks",
  "Conf=Confidence Score (0-100)",
  "Notes=Rationale Cruxx",
  "TechMT=Rationale - Technical Setup (Medium Term)",
  "TechLT=Rationale - Technical Setup (Long Term)",
  "FundST=Rationale - Fundamentals Short Term",
  "FundMLT=Rationale - Fundamentals Medium/Long Term",
  "TechST=Rationale Technical Setup Short Term 1–3 Months",
  "Run=Run #",
  "Date=Run Date",
  "Time=Run Time",
  "LLMShort=LLM",
].join(" | ");

const SWING_TABLE_HEADER_MARKERS = [
  "llm name",
  "exchange symbol",
  "stock symbol",
  "technical setup",
  "confidence score",
  "rationale",
];

const MARKET_COPY: Record<
  SwingTradeMarket,
  {
    label: string;
    portfolioName: string;
    currency: string;
    timezone: string;
    closeHour: number;
    closeMinute: number;
    sheetSuffix: string;
  }
> = {
  india: {
    label: "India",
    portfolioName: "Zerodha Indian equity",
    currency: "INR",
    timezone: "Asia/Kolkata",
    closeHour: 15,
    closeMinute: 30,
    sheetSuffix: "Ind",
  },
  us: {
    label: "US",
    portfolioName: "INDmoney US equity",
    currency: "USD",
    timezone: "America/New_York",
    closeHour: 16,
    closeMinute: 0,
    sheetSuffix: "US",
  },
};

function zonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
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

function zonedWallTimeToUtc(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second?: number;
  },
  timeZone: string,
) {
  const utcGuess = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second ?? 0,
    ),
  );
  const actualParts = zonedDateParts(utcGuess, timeZone);
  const actualAsUtc = Date.UTC(
    actualParts.year,
    actualParts.month - 1,
    actualParts.day,
    actualParts.hour,
    actualParts.minute,
    actualParts.second,
  );
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );
  return new Date(utcGuess.getTime() + (desiredAsUtc - actualAsUtc));
}

function addDays(
  parts: { year: number; month: number; day: number },
  days: number,
) {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayIndex(weekday: string) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function previousBusinessDate(
  parts: { year: number; month: number; day: number },
  weekday: string,
) {
  let back = -1;
  const idx = weekdayIndex(weekday);
  if (idx === 1) back = -3;
  if (idx === 0) back = -2;
  return addDays(parts, back);
}

export function getPreviousMarketClose(
  market: SwingTradeMarket,
  now = new Date(),
) {
  const copy = MARKET_COPY[market];
  const local = zonedDateParts(now, copy.timezone);
  const todayClose = zonedWallTimeToUtc(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: copy.closeHour,
      minute: copy.closeMinute,
    },
    copy.timezone,
  );
  const weekday = weekdayIndex(local.weekday);
  const isWeekend = weekday === 0 || weekday === 6;
  if (!isWeekend && now.getTime() > todayClose.getTime()) {
    return todayClose;
  }
  const previous = previousBusinessDate(local, local.weekday);
  return zonedWallTimeToUtc(
    {
      year: previous.year,
      month: previous.month,
      day: previous.day,
      hour: copy.closeHour,
      minute: copy.closeMinute,
    },
    copy.timezone,
  );
}

function parseApiDate(value?: string | null) {
  if (!value || typeof value !== "string") return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatDateTimeForMarket(date: Date, market: SwingTradeMarket) {
  const timeZone = MARKET_COPY[market].timezone;
  const local = date.toLocaleString("en-IN", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  return `${local} (${date.toISOString()})`;
}

export function formatPreviousMarketClose(
  market: SwingTradeMarket,
  previousClose: Date,
) {
  return formatDateTimeForMarket(previousClose, market);
}

export function getRebalanceDefaultExportSheetName(
  market: SwingTradeMarket,
  now = new Date(),
) {
  const dateLabel = now.toLocaleDateString("en-IN", {
    timeZone: MARKET_COPY[market].timezone,
    day: "numeric",
    month: "short",
  });
  return `${dateLabel} Rebalance (${MARKET_COPY[market].sheetSuffix})`;
}

export function getRebalanceFlowMarker(market: SwingTradeMarket) {
  return `[REBALANCE_FLOW:${market}]`;
}

export function ensureRebalanceFlowMarker(
  prompt: string,
  market: SwingTradeMarket,
) {
  const marker = getRebalanceFlowMarker(market);
  const trimmed = prompt.trimStart();
  if (/^\[REBALANCE_FLOW:(?:india|us)\]/i.test(trimmed)) {
    return prompt.replace(/^\s*\[REBALANCE_FLOW:(?:india|us)\]/i, marker);
  }
  return `${marker}\n${prompt}`;
}

export function inferRebalanceMarketFromPrompt(
  prompt?: string | null,
): SwingTradeMarket | null {
  const text = (prompt || "").toLowerCase();
  if (text.includes("[rebalance_flow:india]")) return "india";
  if (text.includes("[rebalance_flow:us]")) return "us";
  if (/zerodha|indian|india|nse|bse|inr/.test(text) && /rebalance/.test(text)) return "india";
  if (/indmoney|us equity|u\.s\.|nasdaq|nyse|usd/.test(text) && /rebalance/.test(text)) return "us";
  return null;
}

export function buildRebalancePrompt(market: SwingTradeMarket) {
  const copy = MARKET_COPY[market];
  const isIndia = market === "india";
  const benchmark = isIndia
    ? "Nifty / sector index"
    : "S&P 500 / Nasdaq / sector ETF";
  const exchangeExamples = isIndia ? "NSE/BSE" : "NASDAQ/NYSE/AMEX";

  return `${getRebalanceFlowMarker(market)}
Act as a top-tier ${copy.label} equity aggressive swing-trading portfolio strategist combining the skills of a hedge fund trader, technical analyst, momentum screener, sell-side strategist, and portfolio risk manager.

Objective:
Review my current ${copy.portfolioName} holdings and the attached LLM-generated aggressive swing-trade recommendation tables. Using the latest information available online, including market trend, sector rotation, earnings/news catalysts, brokerage views, institutional flows, macro conditions, and technical price-volume setups, suggest a decisive aggressive swing-trade rebalance plan.

Goal:
Convert my current portfolio into the best possible aggressive 1–3 month swing-trade portfolio while avoiding weak, illiquid, overextended, or low-conviction names.

Inputs you will receive in this prompt:
1. Latest portfolio snapshot with current units.
2. Consolidated LLM swing-trade recommendation tables from all completed ${copy.label} swing-trade runs created after the previous market close.
3. Latest Threats report output.

Capital / Portfolio Rules:
- MANDATORY coverage: output exactly one decision row for EVERY stock currently present in the Latest Portfolio Snapshot, even if the decision is Hold. Never omit a current holding because it is weak, unchanged, small, low-conviction, or already discussed in threats.
- Review existing holdings and decide whether each one is Hold, Buy/Add, Trim, or Sell All.
- Evaluate EVERY stock appearing in the attached swing-trade recommendation tables as a possible fresh Buy New candidate.
- Include Buy New rows for the swing-trade candidates that are stronger than existing portfolio names after considering current portfolio concentration, threats, catalysts, momentum, and opportunity cost.
- If a swing-trade candidate is not selected for fresh buy, exclude it; but all current holdings must still have one row.
- Use aggressive but sensible swing-trade logic.
- Prefer liquid ${exchangeExamples} stocks with strong volume, momentum, catalyst, and relative strength.
- Do not recommend too many names just for diversification.
- If a current holding has weak setup, poor momentum, no catalyst, or better opportunity cost elsewhere, recommend Trim or Sell All.
- For new buys, treat Current Units as 0.
- Units Change must be numerical: positive for Buy/Add/Buy New, negative for Trim/Sell All, and 0 for Hold.
- Final Units = Current Units + Units Change.
- Do not invent current units. Use only the units provided in my holdings.
- Use latest realistic ${copy.currency} market price zones while deciding units.
- Prioritize stocks with the highest expected aggressive swing return over 2–12 weeks.

Analysis Method:
For each stock, evaluate:
- Current technical trend
- Support/resistance and breakout structure
- Volume behaviour
- Relative strength vs ${benchmark}
- Catalyst strength
- Recent brokerage / institutional / market commentary
- Risk-reward
- Probability of target achievement in 2–12 weeks
- Opportunity cost compared with other available stocks

Output Rules:
Return ONLY one markdown table.
The table is invalid unless it contains one row for every current portfolio holding from Input Section 1 plus any selected Buy New rows from Input Section 2.
No introduction.
No explanation outside the table.
No disclaimer.
No notes.
No bullet points.
No text before or after the table.

Title:
## [TODAY'S DATE] | Recommended Rebalance | Aggressive Swing Portfolio | Generated by [This output is being generated by LLM Name + Model]

Create one table only with exactly these columns:
| Exchange Symbol | Stock Symbol | Current Units | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Units Change | Final Units | Technical Setup | Entry Range | Stop Loss | Target | Analyst/Source | Units to Buy | Price Per Unit | Total Buy Amount | Upside Horizon (% return) | Weeks | Confidence Score (0-100) | Rationale Cruxx | Score Rationale Cruxx | Rationale Technical Setup Short Term 1–3 Months | Score Rationale Technical Setup Short Term 1–3 Months | Rationale - Technical Setup (Medium Term) | Score Rationale - Technical Setup (Medium Term) | Rationale - Technical Setup (Long Term) | Score Rationale - Technical Setup (Long Term) | Rationale - Fundamentals Short Term | Score Rationale - Fundamentals Short Term | Rationale - Fundamentals Medium/Long Term | Score Rationale - Fundamentals Medium/Long Term |

Formatting Rules:
- Rationale Score rule: every row MUST include a non-blank numeric value in every Score Rationale / rationale-score column. Use only one of these 7 integer choices: -3 (minus three)=very bearish, -2 (minus two)=bearish, -1 (minus one)=slightly bearish, 0=neutral, 1=slightly bullish, 2=bullish, 3=very bullish. Do not return blanks, dashes, N/A, decimals, ranges, percentages, words, or values outside these integers. Each rationale score must justify its adjacent rationale.
- Before finalizing the table, audit every Score Rationale cell; if any score is missing, infer the best -3 to 3 score from the adjacent rationale and fill it. A table with blank rationale scores is invalid.

- Before writing the final table, internally build the complete current-holding symbol checklist from the Latest Portfolio Snapshot and verify every symbol appears exactly once in the output table.
- Rank rows by action priority: Sell All / Trim first, then Buy New / Add, then Hold.
- Keep rationale concise but meaningful.
- Upside Horizon (% return) must be numeric percent value only (example: 12.5).
- Weeks must be a numeric average of the expected target-achievement range (example: for 6-8 weeks, write 7).
- Mention key reason clearly: breakout, weak momentum, better opportunity, sector tailwind, earnings catalyst, overextension, support breach, consolidation, etc.
- For Buy New stocks, write Current Units as 0.
- For Sell All, Units Change must equal negative Current Units and Final Units must be 0.
- For Hold, Units Change must be 0 and Final Units must equal Current Units.
- Do not include any stock unless it is from my current holdings or from the attached LLM recommendation tables.
- Output as many complete rows as you can. A complete table with every current holding is preferred, but a partial table with the generated rows is acceptable when some rows cannot be completed.
- Never omit the table solely because some rows are unavailable; partial rows can still be used by later stages.
- Use only factual/current market intelligence available online and the provided LLM tables.
- Use numeric-only values in cells for all numeric fields (no ${copy.currency}/% text in values).
- Be decisive. Avoid vague comments.
- Final output must be plain markdown table only.`;
}

function asMarkdownTable(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
) {
  if (rows.length === 0) return "_No rows available._";
  const clean = (value: string | number | null | undefined) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .replace(/\|/g, "/")
      .trim();
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(clean).join(" | ")} |`),
  ].join("\n");
}

function normalizeTableCell(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[+()–—-]/g, " ")
    .trim();
}

function isMarkdownSeparatorRow(line: string) {
  const trimmed = line.trim();
  return /^\|?[\s:|\-]+\|?$/.test(trimmed) && trimmed.includes("---");
}

function isSwingRecommendationHeader(line: string) {
  const normalized = normalizeTableCell(line);
  return SWING_TABLE_HEADER_MARKERS.every((marker) =>
    normalized.includes(marker),
  );
}

function isSwingRecommendationTitle(line: string) {
  const normalized = line.toLowerCase();
  return (
    normalized.startsWith("##") &&
    normalized.includes("how to invest") &&
    normalized.includes("generated by")
  );
}

function compactSwingRecommendationResponse(response?: string | null) {
  if (!response?.trim()) return "_No response captured yet._";

  const compactedLines: string[] = [];
  const seenContentLines = new Set<string>();
  let previousWasBlank = false;

  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      isSwingRecommendationTitle(line) ||
      isSwingRecommendationHeader(line) ||
      isMarkdownSeparatorRow(line)
    ) {
      continue;
    }

    if (!line) {
      if (!previousWasBlank && compactedLines.length > 0) {
        compactedLines.push("");
      }
      previousWasBlank = true;
      continue;
    }

    const compactLine = line.replace(/\s+/g, " ");
    const normalizedLine = normalizeTableCell(compactLine);
    if (seenContentLines.has(normalizedLine)) {
      continue;
    }
    seenContentLines.add(normalizedLine);
    compactedLines.push(compactLine);
    previousWasBlank = false;
  }

  return compactedLines.join("\n").trim() || "_No response captured yet._";
}

function formatPortfolioSnapshot(
  market: SwingTradeMarket,
  snapshot: PortfolioSnapshot,
) {
  if (!snapshot) return "_No latest portfolio snapshot available._";

  if (market === "india" && "holdings" in snapshot) {
    const indiaSnapshot = snapshot as ZerodhaPortfolioSnapshotDetail;
    const rows = indiaSnapshot.holdings.map((holding) => [
      holding.exchange,
      holding.tradingsymbol,
      holding.quantity,
      holding.average_price,
      holding.last_price,
      holding.market_value,
      holding.pnl,
      holding.day_change_percentage,
    ]);
    return `Snapshot date: ${indiaSnapshot.snapshot_date}; captured at: ${indiaSnapshot.captured_at}\n\n${asMarkdownTable(
      [
        "Exchange",
        "Stock Symbol",
        "Current Units",
        "Average Price",
        "Last Price",
        "Market Value",
        "PnL",
        "Day Change %",
      ],
      rows,
    )}`;
  }

  if (market === "us" && "holdings" in snapshot) {
    const usSnapshot = snapshot as IndMoneyUsPortfolioSnapshotDetail;
    const rows = usSnapshot.holdings.map((holding) => [
      "US",
      holding.symbol,
      holding.company_name,
      holding.quantity,
      holding.average_price,
      holding.market_price,
      holding.current_value,
      holding.total_pnl_percent,
      holding.portfolio_weight_percent,
    ]);
    return `Snapshot date: ${usSnapshot.snapshot_date}; captured at: ${usSnapshot.captured_at}\n\n${asMarkdownTable(
      [
        "Exchange",
        "Stock Symbol",
        "Company Name",
        "Current Units",
        "Average Price",
        "Market Price",
        "Current Value",
        "Total PnL %",
        "Portfolio Weight %",
      ],
      rows,
    )}`;
  }

  return "_Portfolio snapshot format is unavailable._";
}

function formatPortfolioThreats(analysis: ThreatAnalysis) {
  if (!analysis) return "_No latest Threats report available._";
  const report = analysis.report;
  return [
    `Job: #${analysis.job_id} ${analysis.provider}/${analysis.model}; status: ${analysis.status}; created: ${analysis.created_at}`,
    report?.raw_markdown ||
      "_Threats report has no parsed markdown output yet._",
  ].join("\n\n");
}

function getSwingRunLabel(run: RunResponse, market: SwingTradeMarket) {
  return `#${run.id} ${market === "us" ? "IndMoney US" : "Zerodha"}`;
}

function getSwingRunTimestamp(run: RunResponse, market: SwingTradeMarket) {
  const parsed = parseApiDate(run.created_at);
  return parsed ? formatDateTimeForMarket(parsed, market) : run.created_at;
}

function getModelRunSummary(run: RunResponse, market: SwingTradeMarket) {
  const models = run.run_jobs
    .map((link) => {
      const job = link.job;
      const completed = (job.status || "").toLowerCase() === "completed";
      return `${completed ? "✅ " : ""}${job.provider}/${job.model} at ${getSwingRunTimestamp(run, market)}`;
    })
    .join("; ");
  return `${getSwingRunLabel(run, market)} — ${models || "No model jobs captured"}`;
}

function formatSwingRuns(
  runs: RunResponse[],
  previousClose: Date,
  market: SwingTradeMarket,
  displayMode: "full" | "summary",
) {
  const previousCloseLine = `Previous market close cutoff: ${formatPreviousMarketClose(
    market,
    previousClose,
  )}`;

  if (runs.length === 0) {
    return `${previousCloseLine}\n\n_No completed ${MARKET_COPY[market].label} swing-trade runs found after previous market close._`;
  }

  if (displayMode === "summary") {
    return [
      previousCloseLine,
      runs.map((run) => `- ${getModelRunSummary(run, market)}`).join("\n"),
    ].join("\n\n");
  }

  const formattedRuns = runs
    .map((run) => {
      const jobs = run.run_jobs
        .map((link) => {
          const job = link.job;
          return `### ${getSwingRunLabel(run, market)} | ${job.provider}/${job.model} | ${job.status}\n${compactSwingRecommendationResponse(
            job.response,
          )}`;
        })
        .join("\n\n");
      return `## Swing Trade Run ${getSwingRunLabel(run, market)}\nCreated: ${run.created_at}; export sheet: ${
        run.export_sheet_name || "n/a"
      }\n${jobs}`;
    })
    .join("\n\n---\n\n");

  return [
    previousCloseLine,
    `Columns for all compacted swing rows: ${SWING_COLUMN_LEGEND}`,
    formattedRuns,
  ].join("\n\n");
}

export function buildRebalanceInputBundle({
  market,
  portfolio,
  swingRuns,
  threats,
  previousClose,
  swingDisplayMode = "full",
}: {
  market: SwingTradeMarket;
  portfolio: PortfolioSnapshot;
  swingRuns: RunResponse[];
  threats: ThreatAnalysis;
  previousClose: Date;
  swingDisplayMode?: "full" | "summary";
}) {
  const copy = MARKET_COPY[market];
  return `# Inputs considered at current time

Market: ${copy.label}
Previous market close cutoff: ${formatPreviousMarketClose(market, previousClose)}
Generated at: ${new Date().toISOString()}

## 1. Latest Portfolio Snapshot
${formatPortfolioSnapshot(market, portfolio)}

## 2. Completed Swing Trade Runs After Previous Market Close
${formatSwingRuns(swingRuns, previousClose, market, swingDisplayMode)}

## 3. Latest Threats Report
${formatPortfolioThreats(threats)}`;
}
