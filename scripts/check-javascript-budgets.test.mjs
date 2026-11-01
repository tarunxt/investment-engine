import assert from "node:assert/strict";
import test from "node:test";

import { checkJavaScriptBudgets } from "./check-javascript-budgets.mjs";

const baseline = {
  sourceCommit: "historical-synthetic", sourceReport: "synthetic.json",
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
    evidence: { sha: "candidate", buildId: "build", environment: "offline", windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-11-01T00:01:00Z" },
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

const routes = baseline.routes;
for (const route of Object.keys(routes)) {
  for (const dimension of ["transferred", "decoded"]) {
    for (const value of [undefined, null, "100", true, NaN, Infinity, -Infinity, -1]) {
      test(`${route} ${dimension} rejects malformed ${String(value)} before median`, () => {
        const candidate = report(routes);
        const sample = candidate.profiles[0].samples.find((sample) => sample.target === route);
        sample.metrics[dimension === "transferred" ? "jsTransferBytes" : "jsDecodedBytes"] = value;
        const result = checkJavaScriptBudgets(baseline, candidate);
        assert.ok(result.failures.some((failure) => failure.includes(`${route} ${dimension}`)));
        assert.equal(result.candidateRoutes[route], undefined);
      });
    }
    test(`${route} ${dimension} rejects invalid baseline`, () => {
      for (const value of [undefined, null, "100", true, NaN, Infinity, -1]) {
        for (const field of ["routes", "fixedMaximumBytes"]) {
          const invalid = structuredClone(baseline);
          invalid[field][route][dimension] = value;
          assert.match(checkJavaScriptBudgets(invalid, report(routes)).failures.join("\n"), /invalid baseline/);
        }
      }
    });
  }
  test(`${route} missing fails`, () => {
    const values = structuredClone(routes); delete values[route];
    assert.match(checkJavaScriptBudgets(baseline, report(values)).failures.join("\n"), new RegExp(route));
  });
}
test("measured zero remains valid", () => {
  const values = Object.fromEntries(Object.keys(routes).map((route) => [route, {transferred: 0, decoded: 0}]));
  assert.deepEqual(checkJavaScriptBudgets(baseline, report(values)).failures, []);
});
test("missing and mismatched provenance never passes", () => {
  for (const key of ["sha", "buildId", "environment", "windowStart", "windowEnd"]) {
    const candidate = report(routes); delete candidate.evidence[key];
    assert.match(checkJavaScriptBudgets(baseline, candidate).failures.join("\n"), /Not measured/);
    assert.match(checkJavaScriptBudgets(baseline, report(routes), {[key]: "different"}).failures.join("\n"), /mismatch/);
  }
});

test("missing metric objects and failed samples fail closed", () => {
  for (const route of Object.keys(routes)) {
    for (const mutation of [(sample) => delete sample.metrics, (sample) => { sample.error = "synthetic failure"; }]) {
      const candidate = report(routes);
      mutation(candidate.profiles[0].samples.find((sample) => sample.target === route));
      const result = checkJavaScriptBudgets(baseline, candidate);
      assert.ok(result.failures.length > 0);
      assert.equal(result.candidateRoutes[route], undefined);
    }
  }
});
test("invalid growth policy and missing baseline metadata fail", () => {
  for (const value of [undefined, null, "10", true, NaN, Infinity, -1]) {
    assert.ok(checkJavaScriptBudgets({...baseline, maximumUnexplainedGrowthPercent: value}, report(routes)).failures.length);
  }
  for (const key of ["sourceCommit", "sourceReport"]) {
    const invalid = structuredClone(baseline); delete invalid[key];
    assert.match(checkJavaScriptBudgets(invalid, report(routes)).failures.join("\n"), /missing metadata/);
  }
});
test("invalid and stale sample windows fail", () => {
  const candidate = report(routes);
  candidate.evidence.windowEnd = "invalid";
  assert.match(checkJavaScriptBudgets(baseline, candidate).failures.join("\n"), /sample window/);
  assert.match(checkJavaScriptBudgets(baseline, report(routes), {notBefore: "2026-11-02T00:00:00Z"}).failures.join("\n"), /predates/);
});
