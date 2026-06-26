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

  const moduleObj = { exports: {} };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require,
    console,
    process,
  });
  const script = new vm.Script(outputText, {
    filename: "BullpenAutoRunStageOutputDialog.js",
  });
  script.runInContext(context);
  return moduleObj.exports;
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
        active_positions_found: [
          {
            position_key: "market-2::YES",
            market_id: "market-2",
            market_title: "Will CPI print above expectations?",
            theme: "Macro",
            side: "YES",
            exposure_usd: 24,
          },
        ],
      },
    }),
  );

  assert.match(markup, /Summary Table/);
  assert.match(markup, /Detailed table view/);
  assert.match(markup, /Input Summary/);
  assert.match(markup, /Accepted Candidates Count/);
  assert.match(markup, /Active Positions Found Count/);
  assert.match(markup, /Will rates fall\?/);
  assert.match(markup, /Will CPI print above expectations\?/);
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

test("Bullpen auto-run stage dialog renames Stage 2 LLM probability fields clearly", () => {
  const { BullpenAutoRunStageOutputDialog } = loadStageOutputDialog();

  const markup = renderToStaticMarkup(
    React.createElement(BullpenAutoRunStageOutputDialog, {
      stageTitle: "Stage 2 · Run LLM",
      stageDetail: "LLM review outputs for the stage.",
      onClose: () => {},
      outputs: {
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will rates fall?",
            fair_yes_probability_pct: 61,
            fair_no_probability_pct: 39,
            llm_outputs: [],
          },
        ],
      },
    }),
  );

  assert.match(markup, /Stage 2 Output/);
  assert.match(markup, /LLM Yes %/);
  assert.match(markup, /LLM No %/);
});

test("Bullpen auto-run stage dialog keeps Stage 2 probability cells wired to the LLM breakdown flow", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunStageOutputDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /isBreakdownProbabilityKey/);
  assert.match(source, /BullpenLlmBreakdownDialog/);
  assert.match(source, /Open LLM odds breakdown/);
});

test("Bullpen auto-run stage dialog makes invest rationale fields clickable", () => {
  const { BullpenAutoRunStageOutputDialog } = loadStageOutputDialog();

  const markup = renderToStaticMarkup(
    React.createElement(BullpenAutoRunStageOutputDialog, {
      stageTitle: "Stage 3 · Invest",
      stageDetail: "Event inputs being fed into Stage 3 · Invest.",
      eyebrow: "Stage Input",
      outputLabel: "Inputs",
      onClose: () => {},
      outputs: {
        llm_review_rows: [
          {
            market_id: "market-1",
            question: "Will rates fall?",
            returns_per_day: 140.83,
            selected_side: "NO",
            confidence: "Low",
            evidence_status: "Low",
            event_state: "scheduled_not_occurred",
            adjudication_required: false,
            fair_yes_probability_pct: 12.75,
            fair_no_probability_pct: 87.25,
            reason: "Candidate qualifies for the Events to invest in table.",
            llm_outputs: [],
          },
        ],
      },
    }),
  );

  assert.match(markup, /Open rationale for Returns Per Day/);
  assert.match(markup, /Open rationale for Selected Side/);
  assert.match(markup, /Open rationale for Confidence/);
  assert.match(markup, /Open rationale for Evidence Status/);
  assert.match(markup, /Open rationale for Event State/);
  assert.match(markup, /Open rationale for Adjudication Required/);
});

test("Bullpen LLM breakdown dialog layers above the stage output dialog", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenLlmBreakdownDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /z-\[140\]/);
  assert.match(source, /z-\[150\]/);
});
