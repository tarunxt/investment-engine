import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Stages 5 and 6 are operational and use the existing Bullpen dialog", () => {
  const page = readSource("../app/console/bullpen008/_components/Bullpen008PageClient.tsx");
  assert.match(page, /name: "Exit & Rebalance Plan"/);
  assert.match(page, /name: "Execute & Reconcile"/);
  for (const metric of ["claims", "cancellations", "sells", "trims", "buys", "holds", "blocked", "durable_intents", "partially_filled", "recoverable", "reconciled"]) {
    assert.match(page, new RegExp(metric));
  }
  assert.match(page, /BullpenAutoRunStageOutputDialog/);
  assert.doesNotMatch(page, /disabled=\{phase2/);
  assert.doesNotMatch(page, /Pending Phase 2/);
});

test("008 scheduler and safety controls call only the 008 namespace", () => {
  const urls = readSource("../lib/urls.ts");
  const service = readSource("../services/api.ts");
  for (const endpoint of ["scheduler/pause", "scheduler/resume", "emergency-stop", "emergency-stop/clear"]) {
    assert.match(urls, new RegExp(`/polymarket/bullpen008/${endpoint}`));
  }
  for (const method of ["pauseBullpen008Scheduler", "resumeBullpen008Scheduler", "emergencyStopBullpen008", "clearBullpen008EmergencyStop"]) {
    const section = service.slice(service.indexOf(method), service.indexOf("\n  }", service.indexOf(method)) + 4);
    assert.match(section, /URLs\.bullpen008/);
    assert.doesNotMatch(section, /bullpenAutoLive/);
  }
});

test("Phase 2 popups preserve focus, scroll and z-index behavior", () => {
  const page = readSource("../app/console/bullpen008/_components/Bullpen008PageClient.tsx");
  const dialog = readSource("../app/console/bullpen-ai/_components/BullpenAutoRunStageOutputDialog.tsx");
  assert.match(page, /grid gap-4 lg:grid-cols-3/);
  assert.match(page, /overflow-x-auto/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /document\.body\.style\.overflow = "hidden"/);
  assert.match(dialog, /max-h-\[90vh\]/);
  assert.match(dialog, /z-\[130\]/);
});

test("history exposes immutable plan, intents and alert evidence", () => {
  const types = readSource("../types/api.ts");
  const detail = readSource("../app/console/bullpen008/runs/[runId]/Bullpen008RunDetailClient.tsx");
  const page = readSource("../app/console/bullpen008/_components/Bullpen008PageClient.tsx");
  assert.match(types, /action_plan: Record<string, unknown> \| null/);
  assert.match(types, /execution_intents: Record<string, unknown>\[\]/);
  assert.match(types, /alerts: Bullpen008Alert\[\]/);
  assert.match(detail, /run\.stages\.map/);
  assert.match(page, /Held-position alerts/);
  assert.match(page, /alert\.breach_type/);
});

test("Bullpen 007 composition remains the original three-stage workflow", () => {
  const page = readSource("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
  assert.doesNotMatch(page, /Exit & Rebalance Plan/);
  assert.doesNotMatch(page, /Execute & Reconcile/);
  assert.doesNotMatch(page, /bullpen008/);
});
