import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function loadStageOutputDialog() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunStageOutputDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: "BullpenAutoRunStageOutputDialog.tsx",
  });

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require,
    console,
    process,
  });
  const script = new vm.Script(outputText, {
    filename: "BullpenAutoRunStageOutputDialog.js",
  });
  script.runInContext(context);
  return module.exports;
}

test("Bullpen auto-run stage dialog renders candidate inputs as readable tables and cards", () => {
  const { BullpenAutoRunStageOutputDialog } = loadStageOutputDialog();

  const markup = renderToStaticMarkup(
    React.createElement(BullpenAutoRunStageOutputDialog, {
      stageTitle: "Stage 2 · Run LLM",
      stageDetail: "Event inputs being fed into Stage 2 · Run LLM.",
      eyebrow: "Stage Input",
      outputLabel: "Inputs",
      onClose: () => {},
      outputs: {
        accepted_candidates: [
          {
            market_id: "market-1",
            question: "Will rates fall?",
            theme: "Macro",
            current_yes_odds: 64,
            current_no_odds: 36,
            llm_yes_odds: 61,
            llm_no_odds: 39,
            confidence: "Low",
            evidence_status: "Low",
            event_state: "conflicting",
            adjudication_required: false,
            market_url: "https://example.com/market-1",
            rules: "Rule text for the event input.",
          },
        ],
      },
    }),
  );

  assert.match(markup, /Summary Table/);
  assert.match(markup, /Detailed table view/);
  assert.match(markup, /Will rates fall\?/);
  assert.match(markup, /Open market/);
  assert.match(markup, /Current Yes Odds/);
  assert.match(markup, /Field/);
  assert.match(markup, /Raw JSON/);
});

test("Bullpen auto-run stage dialog keeps primitive overview fields in a key-value table", () => {
  const { BullpenAutoRunStageOutputDialog } = loadStageOutputDialog();

  const markup = renderToStaticMarkup(
    React.createElement(BullpenAutoRunStageOutputDialog, {
      stageTitle: "Stage 3 · Invest",
      stageDetail: "Event inputs being fed into Stage 3 · Invest.",
      eyebrow: "Stage Input",
      outputLabel: "Inputs",
      onClose: () => {},
      outputs: {
        active_position_rows: 7,
        candidate_decision_rows: 9,
        top_candidate_market_ids: ["market-1", "market-2"],
      },
    }),
  );

  assert.match(markup, /Inputs Overview/);
  assert.match(markup, /Active Position Rows/);
  assert.match(markup, /Candidate Decision Rows/);
  assert.match(markup, /market-1/);
});
