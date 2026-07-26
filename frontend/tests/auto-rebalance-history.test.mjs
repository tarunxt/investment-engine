import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const urls = readFileSync(new URL("../lib/urls.ts", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
    import.meta.url,
  ),
  "utf8",
);
const history = readFileSync(
  new URL(
    "../app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx",
    import.meta.url,
  ),
  "utf8",
);
const api = readFileSync(new URL("../services/api.ts", import.meta.url), "utf8");

test("dashboard exposes a clock history link beside each auto-rebalance title", () => {
  assert.match(workflow, /autoRebalanceRuns\(section\.portfolio\)/);
  assert.match(workflow, /Open auto-rebalance run history/);
  assert.match(workflow, /<History className="size-4"/);
});

test("history routes and API methods expose summary and detail screens", () => {
  assert.match(urls, /autoRebalanceHistoryDetail/);
  assert.match(urls, /autoRebalanceRunDetail/);
  assert.match(api, /getAutoRebalanceHistory\(/);
  assert.match(api, /getAutoRebalanceHistoryDetail\(/);
  assert.match(history, /Stage timeline/);
  assert.match(history, /LLM diagnostics and saved output/);
});

test("read-only API calls use bounded transport failover without retry loops", () => {
  assert.match(api, /DEFAULT_API_REQUEST_TIMEOUT_MS = 20_000/);
  assert.match(api, /DEFAULT_API_READ_TOTAL_TIMEOUT_MS = 5_000/);
  assert.match(api, /DEFAULT_API_READ_PRIMARY_ATTEMPT_TIMEOUT_MS = 1_500/);
  assert.match(api, /resolveApiReadTransportCandidates\(url\)/);
  assert.match(api, /api_read_fallback_triggered/);
  assert.doesNotMatch(api, /READ_RETRY_DELAYS_MS/);
  assert.doesNotMatch(api, /while \(true\)/);
});
