import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["lib/scorecardNavigation.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  tsconfig: "tsconfig.json",
  absWorkingDir: new URL("..", import.meta.url).pathname,
});
const { scorecardHref, scorecardPath, stageExecutions, inputRevision, scorecardTabs } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);
test("both brokers retain type, workflow run, tab and exact execution in shareable links", () => {
  for (const [market, slug] of [
    ["zerodha", "zerodha"],
    ["indmoneyUs", "indmoney-us"],
  ]) {
    for (const card of ["rebalance", "technical", "threats", "pairwise"]) {
      for (const tab of Object.keys(scorecardTabs)) {
        assert.equal(
          scorecardHref(market, card, 101, tab, 540),
          "/console/" + slug + "/scorecards/" + card + "/101?tab=" + tab + "&execution=540",
        );
      }
      assert.deepEqual(scorecardPath([card, "101"]), { card, sequence: 101 });
    }
    assert.equal(scorecardHref(market), "/console/" + slug + "/scorecards");
  }
  for (const path of [
    ["unknown"],
    ["technical", "0"],
    ["technical", "1junk"],
    ["technical", "-1"],
    ["threats", "2", "extra"],
  ])
    assert.equal(scorecardPath(path), null);
});
test("execution lookup includes stage retries and legacy references without borrowing another card or broker", () => {
  const marker = (market, card, rev) => "[INDEPENDENT_SCORECARD:" + market + ":" + card + ":" + rev + "]";
  const detail = {
    portfolio: "india",
    runs: [
      { id: 10, prompt: "Legacy execution" },
      { id: 11, prompt: marker("india", "rebalance", 21) },
      { id: 12, prompt: marker("india", "technical", 21) },
      { id: 13, prompt: marker("us", "rebalance", 99) },
    ],
    standalone_jobs: [
      { id: 30, prompt: "Legacy job" },
      { id: 31, prompt: marker("india", "threats", 22) },
    ],
  };
  const selected = stageExecutions(detail, { stage: "rebalance", run_id: 10, job_id: 30 });
  assert.deepEqual(
    selected.runs.map((r) => r.id),
    [11, 10],
  );
  assert.deepEqual(
    selected.standalone.map((j) => j.id),
    [30],
  );
  assert.equal(inputRevision(detail.runs[1].prompt, "rebalance", "zerodha"), 21);
  assert.equal(inputRevision(detail.runs[2].prompt, "rebalance", "zerodha"), null);
  assert.equal(inputRevision(detail.runs[3].prompt, "rebalance", "zerodha"), null);
});
