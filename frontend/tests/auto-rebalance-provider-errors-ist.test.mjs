import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const apiSource = source("../services/api.ts");
const historySource = source("../app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx");
const dashboardSource = source("../app/console/dashboard/_components/RebalanceWorkflowSections.tsx");
const availabilitySource = source("../../backend/app/domains/ai_providers/availability.py");
const targetResolutionSource = source("../../backend/app/domains/portfolio_events/target_resolution.py");
const createRunSource = source("../../backend/app/domains/runs/use_cases/create_run.py");
const taskSource = source("../../backend/app/domains/jobs/tasks.py");


test("timed-out analysis queue requests reconcile against durable auto-rebalance history", () => {
  assert.match(apiSource, /reconcileTimedOutAutoRebalanceStart/);
  assert.match(apiSource, /AUTO_REBALANCE_START_RECONCILIATION_DELAYS_MS/);
  for (const method of [
    "zerodhaRunEvents",
    "zerodhaRunThreats",
    "indmoneyUsRunEvents",
    "indmoneyUsRunThreats",
  ]) {
    assert.match(apiSource, new RegExp(`async ${method}`));
  }
  assert.match(apiSource, /auto_rebalance_sequence/);
  assert.match(apiSource, /auto_rebalance_portfolio/);
});


test("provider balance and quota failures do not block a later funded attempt", () => {
  assert.doesNotMatch(availabilitySource, /CAPACITY_FAILURE_COOLDOWN/);
  assert.match(availabilitySource, /insufficient balance/);
  assert.match(availabilitySource, /exceeded your current quota/);
  assert.match(availabilitySource, /return TargetAvailability\(available=True\)/);
  assert.match(targetResolutionSource, /get_recent_target_availability/);
  assert.match(targetResolutionSource, /default_target_candidates/);
  assert.match(createRunSource, /filter_recently_available_targets/);
  assert.match(taskSource, /is_provider_capacity_error\(exc\)/);
});


test("auto-rebalance user-facing timestamps use the shared IST formatter", () => {
  assert.match(historySource, /formatApiTimestamp/);
  assert.match(historySource, /Asia\/Kolkata/);
  assert.doesNotMatch(historySource, /new Intl\.DateTimeFormat\(undefined/);
  assert.match(dashboardSource, /formatApiTimestamp/);
  assert.match(dashboardSource, /timeZone: INDIA_TIMEZONE/);
});
