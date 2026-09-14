import type { BullpenQuestion } from "@/lib/bullpen-ai";

export type UniversalScanBreakdownRow = {
  label: string;
  count: number;
};

export type UniversalScanBreakdownTable = {
  key: string;
  title: string;
  description: string;
  rows: UniversalScanBreakdownRow[];
};

export type UniversalScanSummary = {
  version: 1;
  completedAt: string;
  durationMs: number;
  totalEvents: number;
  tables: UniversalScanBreakdownTable[];
};

type Counter = Map<string, number>;

function increment(counter: Counter, label: string) {
  counter.set(label, (counter.get(label) ?? 0) + 1);
}

function numericValue(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryFor(question: BullpenQuestion) {
  const text = `${question.category} ${question.question}`.toLowerCase();
  if (/\b(sport|sports|nfl|nba|wnba|nhl|mlb|football|soccer|cricket|tennis|basketball|baseball|hockey|golf|ufc|boxing|formula 1|f1)\b/.test(text)) return "Sports";
  if (/\b(geopolit\w*|war|ceasefire|military|invasion|ukraine|russia|israel|gaza|iran|taiwan|nato|territor\w*)\b/.test(text)) return "Geopolitics & Conflict";
  if (/\b(politic\w*|election\w*|president|prime minister|congress|senate|parliament|governor|mayor|democrat\w*|republican\w*|cabinet|supreme court)\b/.test(text)) return "Politics & Elections";
  if (/\b(crypto|bitcoin|btc|ethereum|eth|solana|token|blockchain|defi)\b/.test(text)) return "Crypto";
  if (/\b(econom\w*|business|company|stock|market cap|fed|interest rate|inflation|gdp|recession|ipo)\b/.test(text)) return "Business & Economy";
  if (/\b(movie|film|music|album|celebrity|award|oscar|emmy|grammy|entertainment|television|tv show)\b/.test(text)) return "Entertainment & Culture";
  if (/\b(technology|science|ai|artificial intelligence|space|nasa|spacex|launch|medical|health)\b/.test(text)) return "Science, Tech & Health";
  if (/\b(weather|climate|temperature|hurricane|storm|rain|snow|earthquake)\b/.test(text)) return "Weather & Climate";
  return "Other";
}

function expiryFor(question: BullpenQuestion, referenceTime: number) {
  if (!question.closeTime) return "No expiry date";
  const closeTime = Date.parse(question.closeTime);
  if (!Number.isFinite(closeTime)) return "No expiry date";
  const istOffset = 330 * 60 * 1_000;
  const day = 24 * 60 * 60 * 1_000;
  const dayDifference = Math.floor((closeTime + istOffset) / day) - Math.floor((referenceTime + istOffset) / day);
  if (dayDifference < 0) return "Past due";
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Tomorrow";
  if (dayDifference <= 7) return "Next 7 days";
  if (dayDifference <= 30) return "Next 30 days";
  if (dayDifference <= 90) return "31–90 days";
  return "More than 90 days";
}

function oddsFor(question: BullpenQuestion) {
  if (question.yesOdds === null || question.noOdds === null) return "Odds unavailable";
  const favorite = Math.max(question.yesOdds, question.noOdds);
  if (favorite < 55) return "Near even (50–54%)";
  if (favorite < 65) return "Lean (55–64%)";
  if (favorite < 80) return "Likely (65–79%)";
  if (favorite < 95) return "Strong favorite (80–94%)";
  return "Near certain (95%+)";
}

function moneyBand(value: string | null, unavailable: string) {
  const amount = numericValue(value);
  if (amount === null) return unavailable;
  if (amount < 100) return "Under $100";
  if (amount < 1_000) return "$100–$999";
  if (amount < 10_000) return "$1K–$9.9K";
  if (amount < 100_000) return "$10K–$99.9K";
  return "$100K+";
}

function structureFor(question: BullpenQuestion) {
  if (question.isBinaryYesNo) return "Binary Yes / No";
  if (question.outcomeCount === 2) return "Other binary";
  if (typeof question.outcomeCount === "number" && question.outcomeCount > 2) return "Multi-outcome";
  return "Structure unavailable";
}

function orderedRows(counter: Counter, order: string[]) {
  return order.map(label => ({ label, count: counter.get(label) ?? 0 }));
}

export function createUniversalScanSummary({
  questions,
  startedAt,
  completedAt,
}: {
  questions: Iterable<BullpenQuestion>;
  startedAt: string;
  completedAt: string;
}): UniversalScanSummary {
  const accumulator = createUniversalScanSummaryAccumulator({ startedAt, completedAt });
  for (const question of questions) accumulator.add(question);
  return accumulator.finish();
}

export function createUniversalScanSummaryAccumulator({
  startedAt,
  completedAt,
}: {
  startedAt: string;
  completedAt: string;
}) {
  const referenceTime = Date.parse(completedAt);
  const category: Counter = new Map();
  const expiry: Counter = new Map();
  const odds: Counter = new Map();
  const volume: Counter = new Map();
  const liquidity: Counter = new Map();
  const structure: Counter = new Map();
  let totalEvents = 0;

  const moneyOrder = ["Under $100", "$100–$999", "$1K–$9.9K", "$10K–$99.9K", "$100K+"];
  return {
    add(question: BullpenQuestion) {
      totalEvents += 1;
      increment(category, categoryFor(question));
      increment(expiry, expiryFor(question, referenceTime));
      increment(odds, oddsFor(question));
      increment(volume, moneyBand(question.volume, "Volume unavailable"));
      increment(liquidity, moneyBand(question.liquidity, "Liquidity unavailable"));
      increment(structure, structureFor(question));
    },
    finish(): UniversalScanSummary {
      return {
        version: 1,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        totalEvents,
        tables: [
          { key: "category", title: "Categories", description: "Primary subject of each market", rows: orderedRows(category, ["Sports", "Politics & Elections", "Geopolitics & Conflict", "Crypto", "Business & Economy", "Entertainment & Culture", "Science, Tech & Health", "Weather & Climate", "Other"]) },
          { key: "expiry", title: "Expiry", description: "Closing date in IST at scan completion", rows: orderedRows(expiry, ["Today", "Tomorrow", "Next 7 days", "Next 30 days", "31–90 days", "More than 90 days", "Past due", "No expiry date"]) },
          { key: "odds", title: "Odds profile", description: "Probability of the favored outcome", rows: orderedRows(odds, ["Near even (50–54%)", "Lean (55–64%)", "Likely (65–79%)", "Strong favorite (80–94%)", "Near certain (95%+)", "Odds unavailable"]) },
          { key: "volume", title: "Total volume", description: "Lifetime market trading volume", rows: orderedRows(volume, [...moneyOrder, "Volume unavailable"]) },
          { key: "liquidity", title: "Liquidity", description: "Available market liquidity", rows: orderedRows(liquidity, [...moneyOrder, "Liquidity unavailable"]) },
          { key: "structure", title: "Market structure", description: "Outcome format of each market", rows: orderedRows(structure, ["Binary Yes / No", "Other binary", "Multi-outcome", "Structure unavailable"]) },
        ],
      };
    },
  };
}
