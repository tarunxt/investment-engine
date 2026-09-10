import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const load = async path => {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};
const { claimReturns, applyClaimReturns } = await load("../lib/bullpen-claim-returns.ts");
const { parseClusterJson, arrangeClusterEvents } = await load("../lib/bullpen-event-clusters.ts");
const now = Date.parse("2026-09-10T12:30:00Z");
const event = { market_id: "1", market_title: "Example", current_yes_odds: 80, current_no_odds: 21, llm_yes_odds: 90, llm_no_odds: 10 };
test("fractional claim days, IST and UTC equivalence, no deadline buffer", () => {
  const a = claimReturns(event, "2026-09-11T06:00:00+05:30", now);
  assert.equal(a.days_left_for_claim, 0.5);
  assert.equal(a.returns_per_day, 40);
  assert.deepEqual(a, { ...claimReturns(event, "2026-09-11T00:30:00Z", now), claim_date: a.claim_date });
  assert.equal(claimReturns(event, "2026-09-11T00:30:00Z", now + 3600000).returns_per_day, 20 / (11 / 24));
});
test("strongest LLM side is independent of current side; preserve missing LLM fallback", () => {
  const claim = "2026-09-11T12:30:00Z";
  assert.equal(claimReturns({ ...event, llm_yes_odds: 10, llm_no_odds: 90 }, claim, now).returns_per_day, 79);
  assert.equal(claimReturns({ ...event, llm_yes_odds: null, llm_no_odds: null }, claim, now).returns_per_day, 20);
});
test("missing, invalid, due, past and claimable estimates never manufacture returns", () => {
  for (const claim of [null, undefined, "", "bad", "2026-09-10T12:30:00Z", "2026-09-09T00:00:00Z"]) assert.equal(claimReturns(event, claim, now).returns_per_day, null);
  for (const odds of [NaN, Infinity, -1, 101, null]) assert.equal(claimReturns({ ...event, current_yes_odds: odds }, "2026-09-11T12:30:00Z", now).returns_per_day, null);
  assert.equal(claimReturns({ ...event, is_claimable_position: true }, "2026-09-11T12:30:00Z", now).returns_per_day, null);
});
test("import preserves claim date by exact market ID and supports legacy three-field rows", () => {
  const base = { market_id: "1", event_name: "Example", cluster_id: "C01" };
  assert.equal(parseClusterJson(JSON.stringify([{ ...base, claim_date: null }]))[0].claim_date, null);
  const rows = parseClusterJson(JSON.stringify([{ ...base, claim_date: "2026-09-12T12:30:00Z" }, { ...base, market_id: "2" }]));
  assert.equal(rows[0].claim_date, "2026-09-12T12:30:00Z");
  assert.equal(rows[1].claim_date, undefined);
  for (const claim_date of ["2026-09-12", "2026-09-12T12:30:00", "September 12", 1789]) assert.throws(() => parseClusterJson(JSON.stringify([{ ...base, claim_date }])));
  const projected = applyClaimReturns([{ ...event, returns_per_day: 999 }, { ...event, market_id: "2", returns_per_day: 999 }], rows, now);
  assert.equal(projected[0].returns_per_day, 10);
  assert.equal(projected[1].returns_per_day, null);
  assert.deepEqual(arrangeClusterEvents(projected, new Map([["1", "C01"], ["2", "C01"]]), 2).map(x => x.market_id), ["1"]);
});
test("published clustering uses the workflow's exact three-field schema", () => {
  const rows = parseClusterJson(readFileSync(new URL("../data/bullpen-event-clusters.json", import.meta.url), "utf8"));
  assert.equal(rows.length, 74);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["cluster_id", "event_name", "market_id"]);
  }
});
