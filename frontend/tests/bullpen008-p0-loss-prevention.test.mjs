import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../app/console/bullpen008/_components/Bullpen008PageClient.tsx", import.meta.url),
  "utf8",
);
const types = readFileSync(new URL("../types/api.ts", import.meta.url), "utf8");

test("Bullpen 008 exposes every P0 risk setting without touching 007", () => {
  for (const key of [
    "geopolitical_min_entry_hours",
    "single_day_high_shock_cap_usd",
    "high_shock_cluster_cap_usd",
    "standard_cluster_cap_usd",
    "conservative_edge_min_pp",
    "high_shock_conservative_edge_min_pp",
    "entry_price_high_zone_pct",
    "entry_price_hard_ceiling_pct",
    "high_zone_max_allocation_usd",
    "min_reward_to_loss_ratio",
    "high_shock_evidence_max_age_minutes",
    "high_shock_min_source_count",
    "single_day_time_exit_hours",
    "take_profit_odds_floor_pct",
    "contingent_exit_odds_floor_pct",
    "odds_drop_15m_pp",
    "odds_drop_24h_pp",
    "quote_confirmation_count",
    "soft_drawdown_pct",
    "hard_drawdown_pct",
    "post_shock_cooldown_hours",
  ]) {
    assert.match(page, new RegExp(key));
    assert.match(types, new RegExp(key));
  }
  assert.match(page, /profile bullpen008/);
  assert.doesNotMatch(page, /updateBullpenAutoLiveSettings/);
});

test("P0 scenario, evidence, exits, drawdown and attribution are visible", () => {
  for (const heading of [
    "Joint-loss scenarios & caps",
    "Conservative edge, reward skew & evidence",
    "Certified time & contingent exits",
    "Drawdown, regimes & cooldowns",
    "P&amp;L attribution",
    "Loss-prevention audit",
    "Counterfactual estimate",
  ]) {
    assert.match(page, new RegExp(heading));
  }
  assert.match(types, /risk_state: Record<string, unknown>/);
});

test("all six stage cards expose P0 headline metrics", () => {
  for (const metric of [
    "high_shock_rejected",
    "evidence_complete",
    "joint_loss_scenarios",
    "maximum_scenario_loss",
    "dormant_contingent_exits",
    "recoverable",
  ]) {
    assert.match(page, new RegExp(metric));
  }
});
