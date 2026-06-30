import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadStageStatusModule() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunStageStatus.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenAutoRunStageStatus.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
  );
}

function createInvestStage({
  progressPercent = 100,
  outputs = {},
} = {}) {
  return {
    key: "invest",
    title: "Stage 3 · Invest",
    subtitle: "Plans buys and exits, then submits orders when the guardrails allow live execution.",
    tone: "yellow",
    state: "current",
    detail: "Stage 3 submitted 1 of 1 planned orders.",
    progressLabel: "3/3 review rows",
    progressPercent,
    isCurrent: true,
    timerStartedAt: "2026-07-01T08:00:00Z",
    timerCompletedAt: null,
    scanCandidates: [],
    activePositionsFound: [],
    inputs: {},
    outputs,
  };
}

test("invest stage success is surfaced as soon as all planned orders are submitted", async () => {
  const { getInvestStageImmediateSuccess } = await loadStageStatusModule();

  const success = getInvestStageImmediateSuccess(
    createInvestStage({
      outputs: {
        orders_planned: 1,
        orders_submitted: 1,
        decision_rows: [
          {
            id: "decision-1",
            run_id: "run-1",
            market_id: "market-1",
            market_title: "Will Claude Fable 5 be restored for US customers by July 2?",
            decision: "BUY_NEW",
            side: "NO",
            reason: "Qualified candidate ranked inside the top-10 returns/day table.",
            order_plan: {
              status: "submitted",
            },
          },
        ],
      },
    }),
  );

  assert.equal(success?.submittedOrders, 1);
  assert.equal(success?.plannedOrders, 1);
  assert.match(success?.message ?? "", /Investment complete\./);
  assert.match(success?.message ?? "", /Will Claude Fable 5 be restored for US customers by July 2/);
});

test("invest stage success stays hidden until every planned order reaches submitted status", async () => {
  const { getInvestStageImmediateSuccess } = await loadStageStatusModule();

  const success = getInvestStageImmediateSuccess(
    createInvestStage({
      outputs: {
        orders_planned: 2,
        orders_submitted: 1,
        decision_rows: [
          {
            id: "decision-1",
            run_id: "run-1",
            market_id: "market-1",
            market_title: "Market one",
            decision: "BUY_NEW",
            side: "NO",
            reason: "Submitted.",
            order_plan: {
              status: "submitted",
            },
          },
          {
            id: "decision-2",
            run_id: "run-1",
            market_id: "market-2",
            market_title: "Market two",
            decision: "BUY_NEW",
            side: "YES",
            reason: "Still pending.",
            order_plan: {
              status: "failed",
            },
          },
        ],
      },
    }),
  );

  assert.equal(success, null);
});
