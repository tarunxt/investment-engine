import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBullpenJsonOutput } from "../app/api/bullpen-ai/_lib/bullpenCli.ts";

const coreModulePromise = import(
  new URL("../app/api/bullpen-ai/_lib/bullpenHealthCore.ts", import.meta.url)
);

function createExecError({
  message,
  stderr = "",
  stdout = "",
  code = 1,
  signal = null,
  killed = false,
}) {
  const error = new Error(message);
  error.stderr = stderr;
  error.stdout = stdout;
  error.code = code;
  error.signal = signal;
  error.killed = killed;
  return error;
}

function buildBaseOptions(execFileImpl) {
  return {
    commandCandidates: ["/usr/local/bin/bullpen"],
    env: {
      HOME: "/home/investor",
    },
    execFileImpl,
    parseJsonOutput: JSON.parse,
    now: () => "2026-06-23T12:00:00.000Z",
  };
}

test("Bullpen CLI health classifies login-required stderr and redacts token-like values", async () => {
  const { runBullpenCliHealthCheckWithExecutor } = await coreModulePromise;
  const fakeJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjcmVkLXgtdGVzdCJ9.signature123456789";

  const result = await runBullpenCliHealthCheckWithExecutor(
    buildBaseOptions(async () => {
      throw createExecError({
        message: "Bullpen login required",
        stderr: `Bullpen login required. token=${fakeJwt}. Run: bullpen login`,
      });
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.health.classification, "AUTH_REQUIRED");
  assert.match(result.health.message, /HOME=\/home\/investor/);
  assert.match(
    result.health.actionNeeded || "",
    /sudo -u investor -H \/usr\/local\/bin\/bullpen login --no-browser/i,
  );
  assert.doesNotMatch(result.health.stderr || "", new RegExp(fakeJwt.replace(/\./g, "\\.")));
  assert.match(result.health.stderr || "", /\[REDACTED/i);
});

test("Bullpen CLI health classifies structured refresh rejection and preserves public condition ids", async () => {
  const { runBullpenCliHealthCheckWithExecutor } = await coreModulePromise;
  const publicConditionId =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

  const result = await runBullpenCliHealthCheckWithExecutor(
    buildBaseOptions(async () => {
      throw createExecError({
        message: "Command failed",
        stdout: JSON.stringify({
          auth_state: "refresh_token_rejected",
          code: "auth.refresh_rejected",
          error_code: "AUTH_REFRESH_REJECTED_LOGIN_REQUIRED",
          requires_auth: true,
          requires_login: true,
          recoverability: "login_required",
          next_command: "bullpen login",
          condition_id: publicConditionId,
        }),
        stderr: "grpc_code = Unauthenticated",
      });
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.health.classification, "AUTH_EXPIRED");
  assert.match(result.health.actionNeeded || "", /bullpen login/i);
  assert.match(result.health.stdout || "", new RegExp(publicConditionId));
});

test("Bullpen CLI health recognizes encrypted Bullpen credentials homes", async (t) => {
  const { runBullpenCliHealthCheckWithExecutor } = await coreModulePromise;
  const credentialHome = await mkdtemp(
    path.join(os.tmpdir(), "bullpen-health-credentials-"),
  );
  await writeFile(path.join(credentialHome, "credentials.json.enc"), "encrypted");

  t.after(async () => {
    await rm(credentialHome, { recursive: true, force: true });
  });

  const result = await runBullpenCliHealthCheckWithExecutor(
    {
      ...buildBaseOptions(async () => {
        throw createExecError({
          message: "Bullpen login required",
          stderr: "Bullpen login required. Run: bullpen login",
        });
      }),
      env: {
        HOME: credentialHome,
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.health.classification, "AUTH_REQUIRED");
  assert.equal(result.health.credentialArtifact, "credentials.json.enc");
  assert.match(result.health.message, /credentials\.json\.enc/);
});

test("Bullpen CLI health reports binary missing after checking every candidate", async () => {
  const { runBullpenCliHealthCheckWithExecutor } = await coreModulePromise;

  const result = await runBullpenCliHealthCheckWithExecutor({
    ...buildBaseOptions(async () => {
      throw createExecError({
        message: "spawn bullpen ENOENT",
        code: "ENOENT",
      });
    }),
    commandCandidates: ["/bad/bin/bullpen", "bullpen"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.health.classification, "BINARY_MISSING");
  assert.equal(result.health.commandPath, "bullpen");
  assert.deepEqual(result.health.attemptedPaths, ["/bad/bin/bullpen", "bullpen"]);
  assert.match(result.health.message, /Install Bullpen or fix BULLPEN_BIN/);
});

test("Bullpen CLI health classifies timeouts", async () => {
  const { runBullpenCliHealthCheckWithExecutor } = await coreModulePromise;

  const result = await runBullpenCliHealthCheckWithExecutor(
    buildBaseOptions(async () => {
      throw createExecError({
        message: "Command timed out after 30000ms",
        signal: "SIGTERM",
        killed: true,
      });
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.health.classification, "TIMEOUT");
  assert.equal(result.health.timedOut, true);
  assert.equal(result.health.signal, "SIGTERM");
});

test("Bullpen CLI health classifies malformed JSON output", async () => {
  const { runBullpenCliHealthCheckWithExecutor } = await coreModulePromise;

  const result = await runBullpenCliHealthCheckWithExecutor(
    buildBaseOptions(async () => ({
      stdout: "{bad json",
      stderr: "",
    })),
  );

  assert.equal(result.ok, false);
  assert.equal(result.health.classification, "JSON_PARSE_ERROR");
  assert.equal(result.payload, null);
});

test("Bullpen CLI health accepts successful JSON output with updater noise", async () => {
  const { parseBullpenCliJsonOutput, runBullpenCliHealthCheckWithExecutor } =
    await coreModulePromise;

  assert.deepEqual(
    parseBullpenCliJsonOutput('Update available: 0.1.999\n{"positions":[],"summary":{}}'),
    { positions: [], summary: {} },
  );

  const result = await runBullpenCliHealthCheckWithExecutor(
    {
      ...buildBaseOptions(async () => ({
        stdout: 'Update available: 0.1.999\n{"positions":[],"summary":{}}',
        stderr: "",
      })),
      parseJsonOutput: parseBullpenJsonOutput,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.health.ok, true);
  assert.equal(result.health.classification, null);
  assert.deepEqual(result.payload, { positions: [], summary: {} });
});
