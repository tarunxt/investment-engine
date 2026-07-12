import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { autoClaimBullpenResolvedPositions } from "../app/api/bullpen-ai/_lib/bullpenHealth.ts";

function buildClaimableSnapshot() {
  return {
    positions: [
      {
        key: "resolved-market::yes",
        marketId: "resolved-market",
        conditionId:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        marketTitle: "Resolved market",
        outcome: "Yes",
        shares: 2,
        averagePrice: 0.45,
        costBasis: 0.9,
        yesOdds: 100,
        noOdds: 0,
        currentPrice: 1,
        currentValue: 2,
        unrealizedPnl: 1.1,
        unrealizedPnlPercent: 122.22,
        marketUrl: "https://example.com/resolved-market",
        closeTime: "2026-07-01T00:00:00.000Z",
        isClaimable: true,
        claimableValue: 2,
        returnsPerDay: null,
        rules: null,
        marketContext: null,
        resolutionSource: null,
      },
    ],
    summary: {
      activeCount: 1,
      claimableCount: 1,
      claimableValue: 2,
      cashBalance: null,
      totalValue: 2,
      unrealizedPnl: 1.1,
      walletValue: 2,
    },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    source: "live-cli",
  };
}

test("Bullpen auto-claim retries unchanged claimable positions after cooldown and resets once the queue clears", async (t) => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "bullpen-health-auto-claim-"),
  );
  const previousStateDir = process.env.BULLPEN_HEALTH_STATE_DIR;
  const previousAutoClaim = process.env.BULLPEN_AUTO_CLAIM_RESOLVED;
  const previousCooldown = process.env.BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS;

  process.env.BULLPEN_HEALTH_STATE_DIR = tempDir;
  process.env.BULLPEN_AUTO_CLAIM_RESOLVED = "true";
  process.env.BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS = "60000";

  t.after(async () => {
    if (previousStateDir === undefined) {
      delete process.env.BULLPEN_HEALTH_STATE_DIR;
    } else {
      process.env.BULLPEN_HEALTH_STATE_DIR = previousStateDir;
    }
    if (previousAutoClaim === undefined) {
      delete process.env.BULLPEN_AUTO_CLAIM_RESOLVED;
    } else {
      process.env.BULLPEN_AUTO_CLAIM_RESOLVED = previousAutoClaim;
    }
    if (previousCooldown === undefined) {
      delete process.env.BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS;
    } else {
      process.env.BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS = previousCooldown;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const calls = [];
  const execFileImpl = async (file, args, options) => {
    calls.push({
      file,
      args,
      home: options.env.HOME || null,
      readOnly: options.env.BULLPEN_READ_ONLY || null,
    });
    return {
      stdout: "{}",
      stderr: "",
      exitCode: 0,
      signal: null,
    };
  };
  const commandCandidates = ["/usr/local/bin/bullpen"];
  const snapshot = buildClaimableSnapshot();

  const first = await autoClaimBullpenResolvedPositions(snapshot, {
    commandCandidates,
    execFileImpl,
    now: () => "2026-07-01T00:00:00.000Z",
  });
  assert.equal(first.attempted, true);
  assert.equal(first.submitted, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    "polymarket",
    "redeem",
    "--condition-ids",
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    "--yes",
    "--non-interactive",
    "--output",
    "json",
  ]);
  assert.equal(calls[0].readOnly, null);

  const second = await autoClaimBullpenResolvedPositions(snapshot, {
    commandCandidates,
    execFileImpl,
    now: () => "2026-07-01T00:00:30.000Z",
  });
  assert.equal(second.attempted, false);
  assert.equal(second.skippedReason, "cooldown");
  assert.equal(calls.length, 1);

  const third = await autoClaimBullpenResolvedPositions(snapshot, {
    commandCandidates,
    execFileImpl,
    now: () => "2026-07-01T00:01:05.000Z",
  });
  assert.equal(third.attempted, true);
  assert.equal(third.submitted, true);
  assert.equal(calls.length, 2);

  const clearedSnapshot = {
    ...snapshot,
    positions: [],
    summary: {
      ...snapshot.summary,
      activeCount: 0,
      claimableCount: 0,
      claimableValue: 0,
    },
  };

  const cleared = await autoClaimBullpenResolvedPositions(clearedSnapshot, {
    commandCandidates,
    execFileImpl,
    now: () => "2026-07-01T00:02:00.000Z",
  });
  assert.equal(cleared.attempted, false);
  assert.equal(cleared.skippedReason, "no-claimable-positions");

  const fourth = await autoClaimBullpenResolvedPositions(snapshot, {
    commandCandidates,
    execFileImpl,
    now: () => "2026-07-01T00:02:05.000Z",
  });
  assert.equal(fourth.attempted, true);
  assert.equal(fourth.submitted, true);
  assert.equal(calls.length, 3);
});

test("Bullpen auto-claim skips claimable rows that do not have verified condition ids", async (t) => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "bullpen-health-auto-claim-missing-condition-"),
  );
  const previousStateDir = process.env.BULLPEN_HEALTH_STATE_DIR;
  const previousAutoClaim = process.env.BULLPEN_AUTO_CLAIM_RESOLVED;

  process.env.BULLPEN_HEALTH_STATE_DIR = tempDir;
  process.env.BULLPEN_AUTO_CLAIM_RESOLVED = "true";

  t.after(async () => {
    if (previousStateDir === undefined) {
      delete process.env.BULLPEN_HEALTH_STATE_DIR;
    } else {
      process.env.BULLPEN_HEALTH_STATE_DIR = previousStateDir;
    }
    if (previousAutoClaim === undefined) {
      delete process.env.BULLPEN_AUTO_CLAIM_RESOLVED;
    } else {
      process.env.BULLPEN_AUTO_CLAIM_RESOLVED = previousAutoClaim;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const calls = [];
  const snapshot = {
    ...buildClaimableSnapshot(),
    positions: [
      {
        ...buildClaimableSnapshot().positions[0],
        conditionId: null,
      },
    ],
  };

  const result = await autoClaimBullpenResolvedPositions(snapshot, {
    commandCandidates: ["/usr/local/bin/bullpen"],
    execFileImpl: async (...args) => {
      calls.push(args);
      return {
        stdout: "{}",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    },
    now: () => "2026-07-01T00:00:00.000Z",
  });

  assert.equal(result.attempted, false);
  assert.equal(result.skippedReason, "no-claimable-positions");
  assert.equal(calls.length, 0);
});
