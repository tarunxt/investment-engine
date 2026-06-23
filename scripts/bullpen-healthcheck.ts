#!/usr/bin/env node

import {
  buildBullpenHealthReport,
  readLastSuccessfulBullpenLiveSnapshot,
  syncBullpenLiveSnapshot,
  writeBullpenHealthReport,
} from "../frontend/app/api/bullpen-ai/_lib/bullpenHealth.ts";

async function postWebhook(report: unknown) {
  const webhookUrl = process.env.BULLPEN_HEALTH_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(report),
  });

  if (!response.ok) {
    throw new Error(`Health webhook returned HTTP ${response.status}.`);
  }
}

async function main() {
  const liveResult = await syncBullpenLiveSnapshot();
  const snapshot =
    liveResult.snapshot || (await readLastSuccessfulBullpenLiveSnapshot());
  const report = buildBullpenHealthReport({
    health: liveResult.health,
    snapshot,
  });

  await writeBullpenHealthReport(report);
  await postWebhook(report);

  console.log(JSON.stringify(report, null, 2));

  if (!liveResult.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
