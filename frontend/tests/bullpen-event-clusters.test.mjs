import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/bullpen-event-clusters.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
const { parseClusterJson, normalizeClusterId, arrangeClusterEvents, loadClusterOverrides } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const event = (id, returns, odds = 90) => ({ market_id: id, market_title: id, returns_per_day: returns, current_yes_odds: odds });

test("published JSON is valid, unique and deterministically numbered", () => {
  const raw = JSON.parse(readFileSync(new URL("../data/bullpen-event-clusters.json", import.meta.url), "utf8"));
  const rows = parseClusterJson(JSON.stringify(raw));
  assert.deepEqual(rows, raw);
  assert.equal(new Set(rows.map(row => row.market_id)).size, rows.length);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["cluster_id", "event_name", "market_id"]);
    assert.ok(Object.values(row).every(value => typeof value === "string"));
  }
  const groups = Map.groupBy(rows, row => row.cluster_id);
  const sorted = [...groups.values()].map(group => group.map(row => row.market_id).sort()).sort((a,b) => a[0].localeCompare(b[0]));
  sorted.forEach((ids, index) => ids.forEach(id => assert.equal(rows.find(row => row.market_id === id).cluster_id, `C${String(index + 1).padStart(2, "0")}`)));
});

test("new browsers and new deployments load published clusters; current overrides remain editable", () => {
  const published = [{ event_name: "Example", market_id: "1", cluster_id: "C01" }];
  const overrides = [{ ...published[0], cluster_id: "C02" }];
  assert.deepEqual(loadClusterOverrides(published, null), published);
  assert.deepEqual(loadClusterOverrides(published, JSON.stringify(overrides)), published);
  const stored = JSON.stringify({ revision: JSON.stringify(published), rows: overrides });
  assert.deepEqual(loadClusterOverrides(published, stored), overrides);
  const updated = [{ ...published[0], cluster_id: "C03" }];
  assert.deepEqual(loadClusterOverrides(updated, stored), updated);
  assert.deepEqual(loadClusterOverrides(published, JSON.stringify({ revision: JSON.stringify(published), rows: [] })), []);
});

test("cluster import accepts LLM field styles and normalizes IDs without changing market identity", () => {
  assert.deepEqual(parseClusterJson(JSON.stringify({ events: [{ "Event name": "Example", "market ID": 123, "Cluster ID": "c3" }] })), [{ event_name: "Example", market_id: "123", cluster_id: "C03" }]);
  assert.equal(normalizeClusterId(" C00100 "), "C100");
  for (const value of ["C00", "x1", "1", "C-1", "C1.5", null]) assert.throws(() => normalizeClusterId(value));
});

test("invalid imports fail atomically and conflicting duplicate market IDs are rejected", () => {
  for (const value of ["broken", "{}", '[{"event_name":"x","cluster_id":"C01"}]', '[{"event_name":"x","market_id":true,"cluster_id":"C01"}]']) assert.throws(() => parseClusterJson(value));
  assert.throws(() => parseClusterJson(JSON.stringify([{ event_name: "A", market_id: "1", cluster_id: "C01" }, { event_name: "A", market_id: "1", cluster_id: "C02" }])), /conflicting/);
  assert.deepEqual(parseClusterJson("[]"), []);
});

test("groups rank by their best return, preserve decreasing returns within groups, and cycle back", () => {
  const rows = [event("a", 1), event("b", 9), event("c", 3), event("d", 8), event("e", 2), event("f", 5)];
  const clusters = new Map([["a", "C03"], ["b", "C03"], ["c", "C06"], ["d", "C06"], ["e", "C03"], ["f", "C01"]]);
  assert.deepEqual(arrangeClusterEvents(rows, clusters, 1).map(row => row.market_id), ["b", "e", "a", "d", "c", "f"]);
  assert.deepEqual(arrangeClusterEvents(rows, clusters, 2).map(row => row.market_id), ["b", "d", "f"]);
  assert.equal(arrangeClusterEvents(rows, clusters, 0), rows);
  assert.deepEqual(rows.map(row => row.market_id), ["a", "b", "c", "d", "e", "f"]);
});

test("cluster views exclude missing or invalid returns, invalid odds, and unassigned rows", () => {
  const rows = [event("valid", 0), event("negative", -1), event("null", null), event("nan", NaN), event("inf", Infinity), event("string", "5"), event("no-odds", 9, 0), event("bad-odds", 8, 101), event("unassigned", 100)];
  const clusters = new Map(rows.filter(row => row.market_id !== "unassigned").map(row => [row.market_id, "C01"]));
  assert.deepEqual(arrangeClusterEvents(rows, clusters, 1).map(row => row.market_id), ["valid", "negative"]);
  assert.deepEqual(arrangeClusterEvents(rows, clusters, 2).map(row => row.market_id), ["valid"]);
});

test("ties are deterministic and changing a cluster assignment immediately changes grouping", () => {
  const rows = [event("b", 4), event("a", 4), event("c", 3)];
  const clusters = new Map([["a", "C02"], ["b", "C01"], ["c", "C01"]]);
  assert.deepEqual(arrangeClusterEvents(rows, clusters, 1).map(row => row.market_id), ["b", "c", "a"]);
  clusters.set("a", "C01");
  assert.deepEqual(arrangeClusterEvents(rows, clusters, 2).map(row => row.market_id), ["a"]);
});
