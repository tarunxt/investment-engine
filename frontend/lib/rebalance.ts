import type {
  IndMoneyUsEventsAnalysis,
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsThreatAnalysis,
  RunResponse,
  ZerodhaEventsAnalysis,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaThreatAnalysis,
} from '@/types/api';
import type { SwingTradeMarket } from '@/lib/swingTrade';

export type RebalancePortfolioKey = 'zerodha' | 'indmoneyUs';

type PortfolioSnapshot = ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null;
type EventsAnalysis = ZerodhaEventsAnalysis | IndMoneyUsEventsAnalysis | null;
type ThreatAnalysis = ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis | null;

const SWING_COLUMN_LEGEND = [
  'LLM=LLM Name + Model',
  'Ex=Exchange Symbol',
  'Sym=Stock Symbol',
  'Name=Stock Name',
  'Setup=Technical Setup',
  'Entry=Entry Range',
  'SL=Stop Loss',
  'Tgt=Target',
  'Src=Analyst Source',
  'Units=Units to Buy',
  'Px=Price per Unit',
  'Amt=Total Buy Amount',
  'Upside=Upside Horizon (%)',
  'Wks=Weeks',
  'Conf=Confidence Score (0-100)',
  'Notes=Rationale Remarks',
  'TechMT=Rationale - Technical Setup (Medium Term)',
  'TechLT=Rationale - Technical Setup (Long Term)',
  'FundST=Rationale - Fundamentals Short Term',
  'FundMLT=Rationale - Fundamentals Medium/Long Term',
  'TechST=Rationale Technical Setup Short Term 1–3 Months',
  'Run=Run #',
  'Date=Run Date',
  'Time=Run Time',
  'LLMShort=LLM',
].join(' | ');

const SWING_TABLE_HEADER_MARKERS = [
  'llm name',
  'exchange symbol',
  'stock symbol',
  'technical setup',
  'confidence score',
  'rationale',
];

const MARKET_COPY: Record<SwingTradeMarket, { label: string; portfolioName: string; currency: string; timezone: string; closeHour: number; closeMinute: number; sheetSuffix: string }> = {
  india: {
    label: 'India',
    portfolioName: 'Zerodha Indian equity',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    closeHour: 15,
    closeMinute: 30,
    sheetSuffix: 'Ind',
  },
  us: {
    label: 'US',
    portfolioName: 'INDmoney US equity',
    currency: 'USD',
    timezone: 'America/New_York',
    closeHour: 16,
    closeMinute: 0,
    sheetSuffix: 'US',
  },
};

function zonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
}

function zonedWallTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number }, timeZone: string) {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0));
  const actualParts = zonedDateParts(utcGuess, timeZone);
  const actualAsUtc = Date.UTC(
    actualParts.year,
    actualParts.month - 1,
    actualParts.day,
    actualParts.hour,
    actualParts.minute,
    actualParts.second,
  );
  const desiredAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  return new Date(utcGuess.getTime() + (desiredAsUtc - actualAsUtc));
}

function addDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayIndex(weekday: string) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

function previousBusinessDate(parts: { year: number; month: number; day: number }, weekday: string) {
  let back = -1;
  const idx = weekdayIndex(weekday);
  if (idx === 1) back = -3;
  if (idx === 0) back = -2;
  return addDays(parts, back);
}

export function getPreviousMarketClose(market: SwingTradeMarket, now = new Date()) {
  const copy = MARKET_COPY[market];
  const local = zonedDateParts(now, copy.timezone);
  const todayClose = zonedWallTimeToUtc(
    { year: local.year, month: local.month, day: local.day, hour: copy.closeHour, minute: copy.closeMinute },
    copy.timezone,
  );
  const weekday = weekdayIndex(local.weekday);
  const isWeekend = weekday === 0 || weekday === 6;
  if (!isWeekend && now.getTime() > todayClose.getTime()) {
    return todayClose;
  }
  const previous = previousBusinessDate(local, local.weekday);
  return zonedWallTimeToUtc(
    { year: previous.year, month: previous.month, day: previous.day, hour: copy.closeHour, minute: copy.closeMinute },
    copy.timezone,
  );
}

export function getRebalanceDefaultExportSheetName(market: SwingTradeMarket, now = new Date()) {
  const dateLabel = now.toLocaleDateString('en-IN', {
    timeZone: MARKET_COPY[market].timezone,
    day: 'numeric',
    month: 'short',
  });
  return `${dateLabel} Rebalance (${MARKET_COPY[market].sheetSuffix})`;
}

export function inferRebalanceMarketFromPrompt(prompt?: string | null): SwingTradeMarket | null {
  const text = (prompt || '').toLowerCase();
  if (text.includes('[rebalance_flow:india]')) return 'india';
  if (text.includes('[rebalance_flow:us]')) return 'us';
  return null;
}

export function buildRebalancePrompt(market: SwingTradeMarket) {
  const copy = MARKET_COPY[market];
  const isIndia = market === 'india';
  const benchmark = isIndia ? 'Nifty / sector index' : 'S&P 500 / Nasdaq / sector ETF';
  const exchangeExamples = isIndia ? 'NSE/BSE' : 'NASDAQ/NYSE/AMEX';

  return `[REBALANCE_FLOW:${market}]
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
- Review existing holdings and decide whether to Hold, Buy/Add, Trim, Sell All, or Buy New.
- Include Buy New stocks only if they are stronger than existing portfolio names.
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
No introduction.
No explanation outside the table.
No disclaimer.
No notes.
No bullet points.
No text before or after the table.

Title:
## [TODAY'S DATE] | Recommended Rebalance | Aggressive Swing Portfolio | Generated by [This output is being generated by LLM Name + Model]

Create one table only with exactly these columns:
| Exchange Symbol | Stock Symbol | Current Units | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Units Change | Final Units | Technical Setup | Entry Range | Stop Loss | Target | Analyst/Source | Units to Buy | Price Per Unit | Total Buy Amount | Upside Horizon (% return in weeks) | Confidence Score (0-100) | Rationale Remarks | Rationale - Technical setup (short term (1-3 months) | Rationale - Technical setup (medium term) | Rationale - Technical setup (long term term) | Rationale - Fundamentals Short term | Rationale - Fundamentals Medium/Long Term |

Formatting Rules:
- Rank rows by action priority: Sell All / Trim first, then Buy New / Add, then Hold.
- Keep rationale concise but meaningful.
- Mention key reason clearly: breakout, weak momentum, better opportunity, sector tailwind, earnings catalyst, overextension, support breach, consolidation, etc.
- For Buy New stocks, write Current Units as 0.
- For Sell All, Units Change must equal negative Current Units and Final Units must be 0.
- For Hold, Units Change must be 0 and Final Units must equal Current Units.
- Do not include any stock unless it is from my current holdings or from the attached LLM recommendation tables.
- Use only factual/current market intelligence available online and the provided LLM tables.
- Use numeric-only values in cells for all numeric fields (no ${copy.currency}/% text in values).
- Be decisive. Avoid vague comments.
- Final output must be plain markdown table only.`;
}

function asMarkdownTable(headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  if (rows.length === 0) return '_No rows available._';
  const clean = (value: string | number | null | undefined) => String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(clean).join(' | ')} |`),
  ].join('\n');
}

function normalizeTableCell(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[+()–—-]/g, ' ')
    .trim();
}

function isMarkdownSeparatorRow(line: string) {
  const trimmed = line.trim();
  return /^\|?[\s:|\-]+\|?$/.test(trimmed) && trimmed.includes('---');
}

function isSwingRecommendationHeader(line: string) {
  const normalized = normalizeTableCell(line);
  return SWING_TABLE_HEADER_MARKERS.every((marker) => normalized.includes(marker));
}

function isSwingRecommendationTitle(line: string) {
  const normalized = line.toLowerCase();
  return normalized.startsWith('##') && normalized.includes('how to invest') && normalized.includes('generated by');
}

function compactSwingRecommendationResponse(response?: string | null) {
  if (!response?.trim()) return '_No response captured yet._';

  const compactedLines: string[] = [];
  let previousWasBlank = false;

  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isSwingRecommendationTitle(line) || isSwingRecommendationHeader(line) || isMarkdownSeparatorRow(line)) {
      continue;
    }

    if (!line) {
      if (!previousWasBlank && compactedLines.length > 0) {
        compactedLines.push('');
      }
      previousWasBlank = true;
      continue;
    }

    compactedLines.push(line.replace(/\s+/g, ' '));
    previousWasBlank = false;
  }

  return compactedLines.join('\n').trim() || '_No response captured yet._';
}

function formatPortfolioSnapshot(market: SwingTradeMarket, snapshot: PortfolioSnapshot) {
  if (!snapshot) return '_No latest portfolio snapshot available._';

  if (market === 'india' && 'holdings' in snapshot) {
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
      ['Exchange', 'Stock Symbol', 'Current Units', 'Average Price', 'Last Price', 'Market Value', 'PnL', 'Day Change %'],
      rows,
    )}`;
  }

  if (market === 'us' && 'holdings' in snapshot) {
    const usSnapshot = snapshot as IndMoneyUsPortfolioSnapshotDetail;
    const rows = usSnapshot.holdings.map((holding) => [
      'US',
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
      ['Exchange', 'Stock Symbol', 'Company Name', 'Current Units', 'Average Price', 'Market Price', 'Current Value', 'Total PnL %', 'Portfolio Weight %'],
      rows,
    )}`;
  }

  return '_Portfolio snapshot format is unavailable._';
}

function formatPortfolioThreats(analysis: ThreatAnalysis) {
  if (!analysis) return '_No latest Threats report available._';
  const report = analysis.report;
  return [
    `Job: #${analysis.job_id} ${analysis.provider}/${analysis.model}; status: ${analysis.status}; created: ${analysis.created_at}`,
    report?.raw_markdown || '_Threats report has no parsed markdown output yet._',
  ].join('\n\n');
}

function formatSwingRuns(runs: RunResponse[], previousClose: Date) {
  if (runs.length === 0) {
    return `_No completed swing-trade runs found after previous market close (${previousClose.toISOString()})._`;
  }

  const formattedRuns = runs
    .map((run) => {
      const jobs = run.run_jobs
        .map((link) => {
          const job = link.job;
          return `### Run #${run.id} | Job #${job.id} | ${job.provider}/${job.model} | ${job.status}\n${compactSwingRecommendationResponse(job.response)}`;
        })
        .join('\n\n');
      return `## Swing Trade Run #${run.id}\nCreated: ${run.created_at}; export sheet: ${run.export_sheet_name || 'n/a'}\n${jobs}`;
    })
    .join('\n\n---\n\n');

  return [`Columns for all compacted swing rows: ${SWING_COLUMN_LEGEND}`, formattedRuns].join('\n\n');
}

export function buildRebalanceInputBundle({
  market,
  portfolio,
  swingRuns,
  threats,
  previousClose,
}: {
  market: SwingTradeMarket;
  portfolio: PortfolioSnapshot;
  swingRuns: RunResponse[];
  threats: ThreatAnalysis;
  events: EventsAnalysis;
  previousClose: Date;
}) {
  const copy = MARKET_COPY[market];
  return `# Inputs considered at current time

Market: ${copy.label}
Previous market close cutoff: ${previousClose.toISOString()}
Generated at: ${new Date().toISOString()}

## 1. Latest Portfolio Snapshot
${formatPortfolioSnapshot(market, portfolio)}

## 2. Completed Swing Trade Runs After Previous Market Close
${formatSwingRuns(swingRuns, previousClose)}

## 3. Latest Threats Report
${formatPortfolioThreats(threats)}`;
}
