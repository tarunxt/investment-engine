import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const enhancer = readFileSync(
  new URL("../app/console/bullpen008/_components/Bullpen008MetricTileDrilldownEnhancer.tsx", import.meta.url),
  "utf8",
);
const layout = readFileSync(new URL("../app/console/bullpen008/layout.tsx", import.meta.url), "utf8");

test("Bullpen 008 mounts the metric-tile drilldown enhancer", () => {
  assert.match(layout, /Bullpen008MetricTileDrilldownEnhancer/);
  assert.match(layout, /<Bullpen008MetricTileDrilldownEnhancer \/>/);
});

test("every Stage 1-6 sub-stage tile has a drilldown key", () => {
  for (const metric of [
    "high_shock_rejected",
    "less_than_48_hour_rejected",
    "existing_high_shock_monitored",
    "timing_unresolved",
    "scanned",
    "accepted",
    "evidence_complete",
    "evidence_stale",
    "conservative_edge_rejected",
    "high_disagreement_rejected",
    "reward_skew_rejected",
    "analysed",
    "joint_loss_scenarios",
    "high_shock_scenarios",
    "unresolved_scenarios",
    "largest_current_scenario_loss",
    "strict_clusters",
    "common_catalyst_clusters",
    "maximum_scenario_loss",
    "binding_risk_tier",
    "contingent_exits_certified",
    "mandatory_time_exits",
    "scenario_cap_result",
    "invested",
    "dormant_contingent_exits",
    "activated_reductions",
    "drawdown_mode",
    "exit_only_status",
    "plan_certificate_result",
    "claims",
    "cancellations",
    "sells",
    "trims",
    "buys",
    "holds",
    "planned",
    "risk_certified",
    "would_submit",
    "ready",
    "durable_intents",
    "submitted",
    "confirmed",
    "partially_filled",
    "recoverable",
    "reconciled",
  ]) {
    assert.match(enhancer, new RegExp(metric));
  }
});

test("metric drilldowns preserve the Events Summary table vocabulary", () => {
  for (const heading of [
    "Event / group",
    "Closing time",
    "Days left",
    "Category",
    "Outcomes",
    "Current Odds",
    "LLM Odds",
    "Returns/day",
    "Why in this tile",
  ]) {
    assert.match(enhancer, new RegExp(heading.replace("/", "\\/")));
  }
  assert.match(enhancer, /getBullpen008Bootstrap/);
  assert.match(enhancer, /getBullpen008Stage/);
  assert.match(enhancer, /stopPropagation/);
  assert.match(enhancer, /role="dialog"/);
});
