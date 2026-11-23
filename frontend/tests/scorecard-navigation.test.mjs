import {readFileSync} from "node:fs";
import ts from "typescript";
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

test("Technical catalogue distinguishes execution from scored listings and links its published output", async () => {
  const {createRequire} = await import("node:module");
  const require = createRequire(import.meta.url);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const code = readFileSync(new URL("../app/console/dashboard/_components/ScorecardScreen.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("catalogue.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selected = ast.statements.filter(s => ts.isFunctionDeclaration(s) && ["Catalogue", "TechnicalCoverage", "Status", "Table"].includes(s.name?.text));
  const js = ts.transpileModule(selected.map(s => s.getText(ast)).join("\n") + "\nexport {Catalogue};", {
    fileName: "catalogue.tsx", compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const props = { market: "zerodha", client: { getAutoRebalanceHistory: (_market, options) => {
    assert.equal(options.technicalCoverage, true);
    return { items: [{ sequence: 248, stages: [{stage:"technical", status:"completed"}], technical_output: {
      output_id:542, run_id:554, expected:34, scored:32, provisional:0
    }}], total:1 };
  }}};
  const noop = () => null;
  const bindings = {useRebalanceCostQuote: () => ({}), useState: () => [0, noop], useCallback: fn => fn, useRead: fn => ({ data: fn() }),
    brokerKey: () => "india", icons: {technical:noop}, cards:["technical"], tones:{}, button:"", panel:"", title: () => "Technical",
    cardNames:{technical:"Technical"}, ArrowUpRight:noop, formatCompactStageTime:noop, Feedback:noop, elapsed:noop,
    formatRebalanceCost:noop, historicalStageInfo:noop, Link: "a", scorecardHref: (_m,_c,seq,tab,run) => [seq,tab,run].filter(Boolean).join("/") };
  const exports = {};
  new Function("require", "exports", ...Object.keys(bindings), js)(require, exports, ...Object.values(bindings));
  for (const card of [undefined,"technical"]) {
    const html = renderToStaticMarkup(React.createElement(exports.Catalogue, {...props, card}));
    const expected = card ? 1 : 2;
    assert.equal((html.match(/Partial score coverage · 32\/34 stocks scored/g) || []).length, expected);
    assert.equal((html.match(/href="248\/output\/554">Saved output #542/g) || []).length, expected);
    assert.match(html, /Execution/);
    assert.match(html, /completed/);
  }
});
