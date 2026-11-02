#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const ROUTES = ["login", "dashboard", "bullpen"];
const DIMENSIONS = { transferred: "jsTransferBytes", decoded: "jsDecodedBytes" };
const validBytes = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function collectRouteJavaScript(report, failures = []) {
  const grouped = new Map();
  if (!Array.isArray(report?.profiles) || !report.profiles.length) {
    failures.push("Not measured: candidate profiles missing");
  }
  for (const profile of report?.profiles ?? []) {
    if (!Array.isArray(profile?.samples)) {
      failures.push("Not measured: profile samples missing");
      continue;
    }
    for (const sample of profile.samples) {
      if (!ROUTES.includes(sample?.target)) continue;
      const values = grouped.get(sample.target) ?? { transferred: [], decoded: [] };
      for (const [dimension, metric] of Object.entries(DIMENSIONS)) {
        const value = sample.metrics?.[metric];
        if (!validBytes(value)) {
          failures.push(`${sample.target} ${dimension}: required finite non-negative number missing or invalid`);
          values.invalid = true;
        } else values[dimension].push(value);
      }
      if (sample.error) {
        failures.push(`${sample.target}: Not measured: sample failed`);
        values.invalid = true;
      }
      grouped.set(sample.target, values);
    }
  }
  return Object.fromEntries([...grouped].filter(([, values]) => !values.invalid)
    .map(([route, values]) => [route, {
      transferred: median(values.transferred), decoded: median(values.decoded),
    }]));
}

export function checkJavaScriptBudgets(baseline, candidate, expected = {}) {
  const failures = [];
  const candidateRoutes = collectRouteJavaScript(candidate, failures);
  for (const key of ["sourceCommit", "sourceReport"]) {
    if (typeof baseline?.[key] !== "string" || !baseline[key].trim()) failures.push(`baseline ${key}: missing metadata`);
  }
  if (!validBytes(baseline?.maximumUnexplainedGrowthPercent)) failures.push("baseline growth percent: invalid");
  const evidence = candidate?.evidence;
  for (const key of ["sha", "buildId", "environment", "windowStart", "windowEnd"]) {
    if (typeof evidence?.[key] !== "string" || !evidence[key].trim()) failures.push(`Not measured: evidence ${key} missing`);
    else if (expected[key] !== undefined && evidence[key] !== expected[key]) failures.push(`Not measured: evidence ${key} mismatch`);
  }
  const start = Date.parse(evidence?.windowStart);
  const end = Date.parse(evidence?.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) failures.push("Not measured: invalid sample window");
  if (expected.notBefore && start < Date.parse(expected.notBefore)) failures.push("Not measured: sample window predates candidate build");
  const growthFactor = 1 + baseline?.maximumUnexplainedGrowthPercent / 100;
  for (const route of ROUTES) {
    const candidateBytes = candidateRoutes[route];
    if (!candidateBytes) failures.push(`${route}: Not measured: candidate report has no valid samples`);
    for (const dimension of Object.keys(DIMENSIONS)) {
      const fixed = baseline?.fixedMaximumBytes?.[route]?.[dimension];
      const original = baseline?.routes?.[route]?.[dimension];
      if (!validBytes(fixed) || !validBytes(original)) {
        failures.push(`${route} ${dimension}: invalid baseline limit`);
        continue;
      }
      if (!candidateBytes) continue;
      const relative = Math.floor(original * growthFactor);
      const actual = candidateBytes[dimension];
      if (actual > fixed) failures.push(`${route} ${dimension}: ${actual} exceeds fixed maximum ${fixed}`);
      if (actual > relative) failures.push(`${route} ${dimension}: ${actual} exceeds baseline-relative maximum ${relative}`);
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
  const result = checkJavaScriptBudgets(baseline, candidate, {
    sha: process.env.PERF_EXPECT_SHA,
    buildId: process.env.PERF_EXPECT_BUILD_ID,
    environment: process.env.PERF_EXPECT_ENVIRONMENT,
    notBefore: process.env.PERF_EXPECT_NOT_BEFORE,
  });
  console.log(JSON.stringify(result.candidateRoutes, null, 2));
  if (result.failures.length > 0) {
    throw new Error(`JavaScript budget failures:\n${result.failures.join("\n")}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
