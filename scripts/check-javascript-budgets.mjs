#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function collectRouteJavaScript(report) {
  const grouped = new Map();
  for (const profile of report.profiles ?? []) {
    for (const sample of profile.samples ?? []) {
      if (!["login", "dashboard", "bullpen"].includes(sample.target)) continue;
      const values = grouped.get(sample.target) ?? {
        transferred: [],
        decoded: [],
      };
      values.transferred.push(sample.metrics.jsTransferBytes);
      values.decoded.push(sample.metrics.jsDecodedBytes);
      grouped.set(sample.target, values);
    }
  }
  return Object.fromEntries(
    [...grouped].map(([route, values]) => [
      route,
      {
        transferred: median(values.transferred),
        decoded: median(values.decoded),
      },
    ]),
  );
}

export function checkJavaScriptBudgets(baseline, candidate) {
  const failures = [];
  const candidateRoutes = collectRouteJavaScript(candidate);
  const growthFactor =
    1 + Number(baseline.maximumUnexplainedGrowthPercent ?? 10) / 100;

  for (const [route, baselineBytes] of Object.entries(baseline.routes)) {
    const candidateBytes = candidateRoutes[route];
    if (!candidateBytes) {
      failures.push(`${route}: candidate report has no samples`);
      continue;
    }
    for (const dimension of ["transferred", "decoded"]) {
      const fixed = baseline.fixedMaximumBytes[route][dimension];
      const relative = Math.floor(baselineBytes[dimension] * growthFactor);
      const actual = candidateBytes[dimension];
      if (actual > fixed) {
        failures.push(
          `${route} ${dimension}: ${actual} exceeds fixed maximum ${fixed}`,
        );
      }
      if (actual > relative) {
        failures.push(
          `${route} ${dimension}: ${actual} exceeds baseline-relative maximum ${relative}`,
        );
      }
    }
  }
  return { candidateRoutes, failures };
}

function main() {
  const [, , baselinePath, candidatePath] = process.argv;
  if (!baselinePath || !candidatePath) {
    throw new Error(
      "Usage: check-javascript-budgets.mjs <baseline.json> <candidate-performance-report.json>",
    );
  }
  const baseline = JSON.parse(readFileSync(path.resolve(baselinePath), "utf8"));
  const candidate = JSON.parse(readFileSync(path.resolve(candidatePath), "utf8"));
  const result = checkJavaScriptBudgets(baseline, candidate);
  console.log(JSON.stringify(result.candidateRoutes, null, 2));
  if (result.failures.length > 0) {
    throw new Error(`JavaScript budget failures:\n${result.failures.join("\n")}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
