import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inventory = JSON.parse(
  readFileSync(
    new URL(
      "../performance-results/high-traffic-response-inventory.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const requiredRoutePatterns = [
  /^\/runs\?summary=true$/,
  /^\/runs$/,
  /^\/runs\/\{id\}$/,
  /^\/polymarket\/state$/,
  /^\/polymarket\/auto-live\/state$/,
  /^\/polymarket\/auto-live\/summary\/dashboard$/,
  /^\/polymarket\/auto-live\/runs$/,
  /^\/polymarket\/auto-live\/runs\/\{run_id\}$/,
  /^\/bullpen-ai\/run-audits$/,
  /^\/bullpen-ai\/run-audits\/\{run_id\}$/,
  /^\/zerodha\/portfolio$/,
  /^\/indmoney-us\/portfolio$/,
  /threats\/latest$/,
  /threats\/history$/,
  /final-actionables/,
  /^\/dashboard\/summary$/,
];

test("high-traffic response inventory stays complete and machine-readable", () => {
  assert.equal(inventory.schemaVersion, 1);
  assert.ok(Array.isArray(inventory.routes));
  assert.ok(inventory.routes.length >= requiredRoutePatterns.length);

  for (const pattern of requiredRoutePatterns) {
    assert.ok(
      inventory.routes.some((route) => pattern.test(route.path)),
      `missing inventory route matching ${pattern}`,
    );
  }

  for (const route of inventory.routes) {
    assert.equal(typeof route.uiCaller, "string", `${route.path}: uiCaller`);
    assert.ok(
      ["initial", "below-fold", "explicit-detail"].includes(route.renderPhase),
      `${route.path}: renderPhase`,
    );
    assert.ok(
      Array.isArray(route.selectedDatabaseColumns),
      `${route.path}: selectedDatabaseColumns`,
    );
    assert.equal(typeof route.pagination, "boolean", `${route.path}: pagination`);
    for (const field of [
      "includesRawPrompt",
      "includesModelOutput",
      "includesAuditBlob",
      "includesOrderHistory",
    ]) {
      assert.equal(typeof route[field], "boolean", `${route.path}: ${field}`);
    }
    for (const percentileField of [
      "p50RouteMs",
      "p75RouteMs",
      "p50DatabaseMs",
      "p75DatabaseMs",
      "p50SerializationMs",
      "p75SerializationMs",
    ]) {
      assert.ok(percentileField in route, `${route.path}: ${percentileField}`);
    }
  }
});

test("measured initial responses remain below the global byte ceiling", () => {
  for (const route of inventory.routes.filter(
    (candidate) => candidate.renderPhase === "initial",
  )) {
    if (route.representativeUncompressedBytes === null) continue;
    assert.ok(
      route.representativeUncompressedBytes < 250_000,
      `${route.path} exceeded 250 KB`,
    );
  }
});
