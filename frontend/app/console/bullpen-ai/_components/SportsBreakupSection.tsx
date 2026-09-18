import type { BullpenQuestionRow, BullpenScanSnapshot } from "@/lib/bullpen-ai";

type BreakdownRow = { label: string; count: number };
type TournamentRow = BreakdownRow & { tags: string[] };
type BreakdownTable = {
  key: string;
  title: string;
  description: string;
  rows: BreakdownRow[];
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const GENERIC_CATEGORY_PARTS = new Set([
  "sport",
  "sports",
  "games",
  "match",
  "matches",
  "yes no",
  "binary",
]);

function cleanLabel(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function categoryParts(question: BullpenQuestionRow) {
  return question.category
    .split(/\s*(?:\.|>|\/|\||•|→)\s*/)
    .map(cleanLabel)
    .filter((part) => part && !GENERIC_CATEGORY_PARTS.has(part.toLowerCase()));
}

function normalizedTags(question: BullpenQuestionRow) {
  const values = [...(question.sportsTags ?? []), ...categoryParts(question)];
  return Array.from(
    new Map(
      values
        .map(cleanLabel)
        .filter(Boolean)
        .map((tag) => [tag.toLowerCase(), tag] as const),
    ).values(),
  ).slice(0, 8);
}

function tournamentFor(question: BullpenQuestionRow) {
  return question.sportsTournament?.trim() || categoryParts(question)[0] || "Unclassified tournament";
}

function sportFor(question: BullpenQuestionRow) {
  const text = [
    question.question,
    question.category,
    question.sportsTournament,
    ...(question.sportsTags ?? []),
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\b(nfl|ncaa football|american football)\b/.test(text)) return "American football";
  if (/\b(soccer|football|epl|uefa|fifa|la liga|bundesliga|serie a|ligue 1)\b/.test(text)) return "Football / Soccer";
  if (/\b(nba|wnba|basketball)\b/.test(text)) return "Basketball";
  if (/\b(mlb|baseball)\b/.test(text)) return "Baseball";
  if (/\b(nhl|hockey)\b/.test(text)) return "Hockey";
  if (/\b(cricket|ipl|t20|odi|test match)\b/.test(text)) return "Cricket";
  if (/\b(tennis|atp|wta|wimbledon|roland garros)\b/.test(text)) return "Tennis";
  if (/\b(ufc|mma|boxing|wrestling)\b/.test(text)) return "Combat sports";
  if (/\b(formula 1|formula one|f1|motorsport|nascar|motogp)\b/.test(text)) return "Motorsports";
  if (/\b(golf|pga|ryder cup)\b/.test(text)) return "Golf";
  if (/\b(esports|dota|counter strike|cs2|valorant|league of legends|rocket league)\b/.test(text)) return "Esports";
  return "Other sports";
}

function expiryFor(question: BullpenQuestionRow, referenceTime: number) {
  if (!question.closeTime) return "No expiry date";
  const closeTime = Date.parse(question.closeTime);
  if (!Number.isFinite(closeTime)) return "No expiry date";
  const istOffset = 330 * 60 * 1_000;
  const days = Math.floor((closeTime + istOffset) / DAY_MS) - Math.floor((referenceTime + istOffset) / DAY_MS);
  if (days < 0) return "Past due";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days <= 7) return "Next 7 days";
  if (days <= 30) return "Next 30 days";
  if (days <= 90) return "31–90 days";
  return "More than 90 days";
}

function oddsFor(question: BullpenQuestionRow) {
  if (question.yesOdds === null || question.noOdds === null) return "Odds unavailable";
  const favorite = Math.max(question.yesOdds, question.noOdds);
  if (favorite < 55) return "Near even (50–54%)";
  if (favorite < 65) return "Lean (55–64%)";
  if (favorite < 80) return "Likely (65–79%)";
  if (favorite < 95) return "Strong favorite (80–94%)";
  return "Near certain (95%+)";
}

function numericValue(value: string | null) {
  if (!value) return null;
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
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

function structureFor(question: BullpenQuestionRow) {
  if (question.isBinaryYesNo) return "Binary Yes / No";
  if (question.outcomeCount === 2) return "Other binary";
  if (typeof question.outcomeCount === "number" && question.outcomeCount > 2) return "Multi-outcome";
  return "Structure unavailable";
}

function countRows(
  questions: BullpenQuestionRow[],
  classify: (question: BullpenQuestionRow) => string,
  order: string[] = [],
) {
  const counts = new Map<string, number>();
  questions.forEach((question) => {
    const label = classify(question);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  const orderedLabels = [
    ...order.filter((label) => counts.has(label)),
    ...Array.from(counts.keys()).filter((label) => !order.includes(label)).sort(
      (left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left.localeCompare(right),
    ),
  ];
  return orderedLabels.map((label) => ({ label, count: counts.get(label) ?? 0 }));
}

export function buildSportsBreakup(snapshot: BullpenScanSnapshot | null) {
  const questions = snapshot?.questions ?? [];
  const parsedReferenceTime = snapshot?.scannedAt ? Date.parse(snapshot.scannedAt) : Number.NaN;
  const referenceTime = Number.isFinite(parsedReferenceTime) ? parsedReferenceTime : Date.now();
  const tournamentMap = new Map<string, TournamentRow>();
  questions.forEach((question) => {
    const label = tournamentFor(question);
    const key = label.toLowerCase();
    const current = tournamentMap.get(key) ?? { label, count: 0, tags: [] };
    current.count += 1;
    current.tags = Array.from(
      new Map([...current.tags, ...normalizedTags(question)].map((tag) => [tag.toLowerCase(), tag] as const)).values(),
    ).slice(0, 8);
    tournamentMap.set(key, current);
  });
  const tournaments = Array.from(tournamentMap.values()).sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label),
  );
  const moneyOrder = ["Under $100", "$100–$999", "$1K–$9.9K", "$10K–$99.9K", "$100K+"];
  const tables: BreakdownTable[] = [
    { key: "sports-category", title: "Sports Categories", description: "Sport or discipline represented by each filtered event", rows: countRows(questions, sportFor) },
    { key: "expiry", title: "Expiry", description: "Closing date in IST at filter completion", rows: countRows(questions, (question) => expiryFor(question, referenceTime), ["Today", "Tomorrow", "Next 7 days", "Next 30 days", "31–90 days", "More than 90 days", "Past due", "No expiry date"]) },
    { key: "odds", title: "Odds Profile", description: "Probability of the favored outcome", rows: countRows(questions, oddsFor, ["Near even (50–54%)", "Lean (55–64%)", "Likely (65–79%)", "Strong favorite (80–94%)", "Near certain (95%+)", "Odds unavailable"]) },
    { key: "volume", title: "Total Volume", description: "Lifetime market trading volume", rows: countRows(questions, (question) => moneyBand(question.volume, "Volume unavailable"), [...moneyOrder, "Volume unavailable"]) },
    { key: "liquidity", title: "Liquidity", description: "Available market liquidity", rows: countRows(questions, (question) => moneyBand(question.liquidity, "Liquidity unavailable"), [...moneyOrder, "Liquidity unavailable"]) },
    { key: "structure", title: "Market Structure", description: "Outcome format of each filtered sports market", rows: countRows(questions, structureFor, ["Binary Yes / No", "Other binary", "Multi-outcome", "Structure unavailable"]) },
  ];
  return { totalEvents: questions.length, tournaments, tables };
}

function shareLabel(count: number, total: number) {
  return total > 0 ? `${((count * 100) / total).toFixed(1)}%` : "0.0%";
}

function BreakdownCard({ table, totalEvents }: { table: BreakdownTable; totalEvents: number }) {
  return (
    <article className="overflow-hidden rounded-xl border border-emerald-200 bg-white/90">
      <div className="border-b border-emerald-100 px-4 py-3">
        <h3 className="font-semibold text-emerald-950">{table.title}</h3>
        <p className="mt-0.5 text-xs text-emerald-700">{table.description}</p>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="bg-emerald-50 text-left text-xs uppercase tracking-wide text-emerald-700"><th className="px-4 py-2 font-semibold">Breakdown</th><th className="px-4 py-2 text-right font-semibold">Events</th><th className="px-4 py-2 text-right font-semibold">Share</th></tr></thead>
        <tbody className="divide-y divide-emerald-100">{table.rows.length > 0 ? table.rows.map((row) => <tr key={row.label}><td className="px-4 py-2 text-slate-700">{row.label}</td><td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">{row.count.toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right tabular-nums text-slate-500">{shareLabel(row.count, totalEvents)}</td></tr>) : <tr><td className="px-4 py-3 text-slate-500" colSpan={3}>No filtered events in this snapshot.</td></tr>}</tbody>
        <tfoot><tr className="bg-emerald-50 font-semibold text-emerald-950"><td className="px-4 py-2">Total</td><td className="px-4 py-2 text-right tabular-nums">{totalEvents.toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right">{totalEvents > 0 ? "100%" : "0%"}</td></tr></tfoot>
      </table></div>
    </article>
  );
}

export function SportsBreakupSection({ snapshot }: { snapshot: BullpenScanSnapshot | null }) {
  const summary = buildSportsBreakup(snapshot);
  return (
    <section aria-label="Sports Breakup" className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-xl font-semibold text-emerald-950">Sports Breakup</h2><p className="mt-1 text-sm text-emerald-800">Breakdown of the events that passed the active Bullpen Sports filters.</p></div>
        <div className="rounded-xl border border-emerald-200 bg-white/80 px-4 py-3 text-right"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Events that passed filters</p><p className="mt-1 text-xl font-bold tabular-nums text-emerald-950">{summary.totalEvents.toLocaleString("en-IN")}</p></div>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <article className="overflow-hidden rounded-xl border border-emerald-200 bg-white/90 lg:col-span-2">
          <div className="border-b border-emerald-100 px-4 py-3"><h3 className="font-semibold text-emerald-950">Tournaments</h3><p className="mt-0.5 text-xs text-emerald-700">Tournament or league, associated tags, and filtered-event count</p></div>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="bg-emerald-50 text-left text-xs uppercase tracking-wide text-emerald-700"><th className="px-4 py-2 font-semibold">Tournament</th><th className="px-4 py-2 font-semibold">Tag(s)</th><th className="px-4 py-2 text-right font-semibold">Events</th><th className="px-4 py-2 text-right font-semibold">Share</th></tr></thead>
            <tbody className="divide-y divide-emerald-100">{summary.tournaments.length > 0 ? summary.tournaments.map((row) => <tr key={row.label}><td className="px-4 py-2 font-medium text-slate-800">{row.label}</td><td className="px-4 py-2 text-slate-600">{row.tags.length > 0 ? row.tags.join(", ") : "—"}</td><td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">{row.count.toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right tabular-nums text-slate-500">{shareLabel(row.count, summary.totalEvents)}</td></tr>) : <tr><td className="px-4 py-3 text-slate-500" colSpan={4}>No filtered sports events in this snapshot.</td></tr>}</tbody>
            <tfoot><tr className="bg-emerald-50 font-semibold text-emerald-950"><td className="px-4 py-2" colSpan={2}>Total</td><td className="px-4 py-2 text-right tabular-nums">{summary.totalEvents.toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right">{summary.totalEvents > 0 ? "100%" : "0%"}</td></tr></tfoot>
          </table></div>
        </article>
        {summary.tables.map((table) => <BreakdownCard key={table.key} table={table} totalEvents={summary.totalEvents} />)}
      </div>
    </section>
  );
}
