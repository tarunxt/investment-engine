import assert from "node:assert/strict";
import test from "node:test";

import { checkJavaScriptBudgets } from "./check-javascript-budgets.mjs";

const baseline = {
  maximumUnexplainedGrowthPercent: 10,
  fixedMaximumBytes: {
    login: { transferred: 250, decoded: 700 },
    dashboard: { transferred: 300, decoded: 900 },
    bullpen: { transferred: 450, decoded: 1400 },
  },
  routes: {
    login: { transferred: 100, decoded: 300 },
    dashboard: { transferred: 200, decoded: 600 },
    bullpen: { transferred: 300, decoded: 1000 },
  },
};

function report(routeValues) {
  return {
    profiles: [
      {
        samples: Object.entries(routeValues).flatMap(([target, metrics]) => [
          { target, metrics: { jsTransferBytes: metrics.transferred, jsDecodedBytes: metrics.decoded } },
          { target, metrics: { jsTransferBytes: metrics.transferred, jsDecodedBytes: metrics.decoded } },
          { target, metrics: { jsTransferBytes: metrics.transferred, jsDecodedBytes: metrics.decoded } },
        ]),
      },
    ],
  };
}

test("JavaScript gate checks transferred and decoded bytes separately", () => {
  const result = checkJavaScriptBudgets(
    baseline,
    report({
      login: { transferred: 100, decoded: 300 },
      dashboard: { transferred: 200, decoded: 600 },
      bullpen: { transferred: 300, decoded: 1000 },
    }),
  );
  assert.deepEqual(result.failures, []);
});

test("JavaScript gate rejects more than ten percent unexplained growth", () => {
  const result = checkJavaScriptBudgets(
    baseline,
    report({
      login: { transferred: 111, decoded: 300 },
      dashboard: { transferred: 200, decoded: 661 },
      bullpen: { transferred: 300, decoded: 1000 },
    }),
  );
  assert.match(result.failures.join("\n"), /login transferred/);
  assert.match(result.failures.join("\n"), /dashboard decoded/);
});

test("fixed maximum still rejects a newly raised baseline", () => {
  const raisedBaseline = structuredClone(baseline);
  raisedBaseline.routes.bullpen.decoded = 1390;
  const result = checkJavaScriptBudgets(
    raisedBaseline,
    report({
      login: { transferred: 100, decoded: 300 },
      dashboard: { transferred: 200, decoded: 600 },
      bullpen: { transferred: 300, decoded: 1401 },
    }),
  );
  assert.match(result.failures.join("\n"), /fixed maximum 1400/);
});
