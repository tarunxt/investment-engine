import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Bullpen Sports renders Sports Breakup immediately above Events Summary", () => {
  const page = read("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
  assert.match(
    page,
    /workspaceProfile === "bullpen-sports"[\s\S]*?<SportsBreakupSection snapshot=\{activeVisibleSnapshot\}[\s\S]*?<BullpenQuestionsTable/,
  );
});

test("Sports Breakup includes normalized tournament, tag, and sport columns", () => {
  const component = read("../app/console/bullpen-ai/_components/SportsBreakupSection.tsx");
  for (const label of [
    "Sports Breakup",
    "Events that passed filters",
    "Tournaments",
    "Tag",
    "Sport",
    "Sports Categories",
    "Expiry",
    "Odds Profile",
    "Total Volume",
    "Liquidity",
    "Market Structure",
  ]) {
    assert.match(component, new RegExp(label.replace(/[()]/g, "\\$&")));
  }
  assert.match(component, /summary\.tournaments\.map/);
  assert.match(component, /canonicalTournament\(question\)/);
  assert.match(component, /polymarketTournamentCodes/);
  assert.doesNotMatch(component, />Tag\(s\)</);
  assert.match(component, /\{row\.tag\}/);
  assert.match(component, /\{row\.sport\}/);
  assert.match(component, /shareLabel\(row\.count, summary\.totalEvents\)/);
});

test("saved Gamma candidates preserve tournament and tag metadata", () => {
  const route = read("../app/api/bullpen-ai/route.ts");
  const types = read("../lib/bullpen-ai.ts");
  assert.match(types, /sportsTournament\?: string \| null/);
  assert.match(types, /sportsTags\?: string\[\]/);
  assert.match(route, /question\.sportsTournament = sportsTournament/);
  assert.match(route, /question\.sportsTags = sportsTags/);
});
