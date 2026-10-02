import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertTypeScriptParses(relativePath) {
  const source = read(relativePath);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: relativePath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
  );
}

test("Bullpen positions use one auth context and passive page-load reads", () => {
  const positionsSource = read("../app/api/bullpen-ai/positions/route.ts");
  const marketResolutionSource = read(
    "../app/api/bullpen-ai/_lib/polymarketMarketUrls.ts",
  );

  assert.match(positionsSource, /createBackendSessionContext\(request\)/);
  assert.match(
    positionsSource,
    /loadTrackedPositionsFallback\(context: BackendSessionContext\)/,
  );
  assert.match(
    positionsSource,
    /fetchBackendJsonWithSession<PolymarketBotState>/,
  );
  assert.doesNotMatch(positionsSource, /new URL\("\/backend-api\/polymarket\/state"/);
  assert.match(positionsSource, /passiveValue === null\s*\? true/);
  assert.match(positionsSource, /forceFresh\s*\? false/);
  assert.match(positionsSource, /backendQuery\.set\("passive", "true"\)/);
  assert.match(
    positionsSource,
    /backendAccessToken:\s*context\.accessToken/,
  );
  assert.match(
    positionsSource,
    /runtimeSearch:\s*\(path, options\) =>\s*fetchBackendJsonWithSession\(context, path, options\)/,
  );
  assert.match(
    marketResolutionSource,
    /accessToken:\s*options\.backendAccessToken/,
  );
  assert.match(
    marketResolutionSource,
    /allowRuntimeQuestionFallback === false/,
  );
  assert.match(
    marketResolutionSource,
    /maxRuntimeQuestionFallbacks \?\? 1/,
  );
  assert.match(
    positionsSource,
    /allowRuntimeQuestionFallback:\s*false/,
  );
  assert.match(
    positionsSource,
    /\{ allowRuntimeQuestionFallback: !passive \}/,
  );
  assert.match(
    positionsSource,
    /\{ allowRuntimeQuestionFallback: false \}/,
  );
  assert.match(positionsSource, /conditionId:\s*position\.conditionId/);
  assert.match(
    marketResolutionSource,
    /params\.append\("conditionId", conditionId\)/,
  );
  assert.match(
    marketResolutionSource,
    /recordsByConditionId\.get\(question\.conditionId\.trim\(\)\)/,
  );
  assert.match(
    marketResolutionSource,
    /question-text match[\s\S]+authoritativeMarketOpen:\s*null/,
  );
});

test("Bullpen healthcheck systemd unit is a passive backend cache reader", () => {
  const installer = read("../../deploy/no-docker/install-bullpen-healthcheck.sh");
  const service = read(
    "../../deploy/no-docker/systemd/credx-bullpen-healthcheck.service",
  );
  const timer = read(
    "../../deploy/no-docker/systemd/credx-bullpen-healthcheck.timer",
  );
  const workflow = read("../../.github/workflows/deploy.yml");

  assert.match(installer, /systemctl enable --now "\$TIMER_NAME"/);
  assert.match(installer, /systemctl start "\$SERVICE_NAME"/);
  assert.match(installer, /--property=ExecMainStatus/);
  assert.match(installer, /journalctl --unit "\$SERVICE_NAME"/);
  assert.match(installer, /BACKEND_ENV_FILE=.*\/etc\/investor\/backend\.env/);
  assert.match(installer, /backend\/\.venv\/bin\/python/);
  assert.doesNotMatch(installer, /FRONTEND_ENV_FILE|\/usr\/bin\/node/);
  assert.match(
    service,
    /-m app\.domains\.polymarket\.passive_healthcheck/,
  );
  assert.match(service, /EnvironmentFile=__BACKEND_ENV_FILE__/);
  assert.doesNotMatch(service, /scripts\/bullpen-healthcheck|\/usr\/bin\/node/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(workflow, /install-bullpen-healthcheck\.sh/);
  assert.match(
    workflow,
    /BACKEND_ENV_FILE="\$BACKEND_ENV_FILE"[\s\S]+install-bullpen-healthcheck\.sh/,
  );
});

test("Bullpen Celery launchers bound retained memory and retire the legacy override", () => {
  const primaryLauncher = read(
    "../../deploy/no-docker/scripts/run-celery-worker.sh",
  );
  const planningLauncher = read(
    "../../deploy/no-docker/scripts/run-celery-auto-live-worker.sh",
  );
  const emailLauncher = read(
    "../../deploy/no-docker/scripts/run-celery-email-worker.sh",
  );
  const redeploy = read("../../deploy/no-docker/redeploy.sh");
  const productionDocs = read("../../docs/production-deploy.md");
  const auditDocs = read("../../docs/bullpen-run-audit.md");

  assert.match(primaryLauncher, /CELERY_AI_WORKER_CONCURRENCY:-1/);
  assert.match(primaryLauncher, /-Q "\$EFFECTIVE_CELERY_WORKER_QUEUES"/);
  assert.match(emailLauncher, /-Q email/);
  assert.match(emailLauncher, /CELERY_EMAIL_WORKER_CONCURRENCY:-1/);
  assert.match(primaryLauncher, /CELERY_WORKER_MAX_TASKS_PER_CHILD:-\$\{CELERY_MAX_TASKS_PER_CHILD:-25\}/);
  assert.match(primaryLauncher, /CELERY_WORKER_MAX_MEMORY_PER_CHILD_KB:-800000/);
  assert.match(planningLauncher, /CELERY_AUTO_LIVE_MAX_TASKS_PER_CHILD:-1/);
  assert.match(redeploy, /remove_obsolete_primary_worker_dropins/);
  assert.match(redeploy, /no-beat-queue\.conf/);
  assert.match(redeploy, /validate_primary_worker_launcher/);
  assert.match(productionDocs, /replaces\s+its only child after every completed run/);
  assert.match(auditDocs, /replaced after every completed task/);
});

test("changed Bullpen TypeScript files have no syntax diagnostics", () => {
  for (const relativePath of [
    "../auth.ts",
    "../app/api/auth/[...nextauth]/route.ts",
    "../app/api/bullpen-ai/_lib/backendBullpenRuntime.ts",
    "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
    "../app/api/bullpen-ai/positions/route.ts",
  ]) {
    assertTypeScriptParses(relativePath);
  }
});

class RefreshClock {
  nowMs = 0;
  nextId = 1;
  timers = new Map();

  now = () => this.nowMs;

  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.nowMs + delayMs });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(ms) {
    this.nowMs += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.nowMs) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

// Execute the actual session, transport, and single-flight modules. Only the
// Next/Auth.js boundary, fetch, and clock are mocked; no real credentials or
// network are involved in these recovery regressions.
function loadRefreshRuntime({ fetch, clock, update = async () => {} }) {
  const modulePaths = {
    session: "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
    runtime: "../app/api/bullpen-ai/_lib/backendBullpenRuntime.ts",
    singleFlight: "../lib/singleFlight.ts",
    transport: "../lib/boundedApiTransport.ts",
  };
  const modules = new Map([
    ["node:crypto", { createHash }],
    ["@auth/core/jwt", { getToken: async () => null }],
    ["next/server", { NextResponse: Response }],
    ["@/auth", { resolveNextAuthSecret: () => "unused", unstable_update: update }],
    ["@/lib/authSessionCookie", {
      readCookieNames: () => [],
      resolveSessionCookieSecurity: () => false,
    }],
  ]);
  const aliases = {
    "./backendBullpenRuntime": "runtime",
    "@/lib/singleFlight": "singleFlight",
    "@/lib/boundedApiTransport": "transport",
  };
  function load(specifier) {
    const id = aliases[specifier] ?? specifier;
    if (modules.has(id)) return modules.get(id);
    assert.ok(modulePaths[id], `Unexpected runtime import: ${id}`);
    const output = ts.transpileModule(read(modulePaths[id]), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const loaded = { exports: {} };
    modules.set(id, loaded.exports);
    new Function(
      "exports", "module", "require", "fetch", "setTimeout", "clearTimeout", "process",
      output,
    )(
      loaded.exports, loaded, load, fetch, clock.setTimeout, clock.clearTimeout,
      { env: { BACKEND_API_URL: "http://backend.test" } },
    );
    return loaded.exports;
  }
  return { ...load("session"), ...load("runtime"), ...load("transport") };
}

function refreshContext(overrides = {}) {
  return {
    accessToken: "fixture-expired-access",
    refreshToken: "fixture-refresh",
    accessTokenExpiresAt: 0,
    hasAuthJsSession: false,
    sessionGeneration: "fixture-session",
    sessionSubject: null,
    rotatedTokens: null,
    ...overrides,
  };
}

function refreshedResponse() {
  return Response.json({
    access_token: "fixture-new-access",
    refresh_token: "fixture-new-refresh",
    expires_in: 900,
  });
}

const flushRefreshPromises = () => new Promise((resolve) => setImmediate(resolve));

test("a timed-out BFF waiter cannot pin later requests to a hung refresh", async () => {
  const clock = new RefreshClock();
  let recovered = false;
  const calls = [];
  const runtime = loadRefreshRuntime({
    clock,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (!recovered) return new Promise(() => {});
      return refreshedResponse();
    },
  });
  const request = () => {
    const context = refreshContext();
    return runtime.executeBoundedApiRequest({
      method: "GET",
      candidates: [{ baseUrl: "http://backend.test", stage: "primary", transport: "fixture" }],
      circuit: new runtime.ApiOriginCircuitBreaker(),
      clock,
      totalBudgetMs: 1_000,
      primaryAttemptBudgetMs: 1_000,
      fetchCandidate: async () => ({
        status: context.rotatedTokens ? 200 : 401,
        statusText: "",
        headers: new Headers(),
        body: null,
      }),
      refreshAuthentication: (signal) => runtime.rotateBackendTokens(context, signal),
    });
  };
  const first = assert.rejects(request(), runtime.ApiTransportDeadlineError);
  await flushRefreshPromises();
  clock.advance(1_000);
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);

  recovered = true;
  clock.advance(2_000);
  await flushRefreshPromises();
  assert.equal(calls[0].options.signal.aborted, true);
  const retry = request();
  await flushRefreshPromises();
  clock.advance(1_000);
  assert.equal((await retry).response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(clock.timers.size, 0);
});

test("the shared deadline covers a stalled refresh response body and discards late results", async () => {
  const clock = new RefreshClock();
  const updates = [];
  let resolveBody;
  let calls = 0;
  let initialSignal;
  const runtime = loadRefreshRuntime({
    clock,
    update: async (tokens) => updates.push(tokens),
    fetch: async (_url, options) => {
      calls += 1;
      if (calls > 1) return refreshedResponse();
      initialSignal = options.signal;
      return {
        ok: true,
        status: 200,
        text: () => new Promise((resolve) => { resolveBody = resolve; }),
      };
    },
  });
  const firstContext = refreshContext({ hasAuthJsSession: true });
  const first = assert.rejects(
    runtime.rotateBackendTokens(firstContext),
    runtime.ApiTransportDeadlineError,
  );
  await flushRefreshPromises();
  clock.advance(3_000);
  await first;
  assert.equal(initialSignal.aborted, true);
  assert.equal(firstContext.rotatedTokens, null);

  const nextContext = refreshContext({ hasAuthJsSession: true });
  await runtime.rotateBackendTokens(nextContext);
  assert.equal(calls, 2);
  resolveBody(JSON.stringify({ access_token: "fixture-late", refresh_token: "fixture-late" }));
  await flushRefreshPromises();
  assert.equal(firstContext.rotatedTokens, null);
  assert.equal(nextContext.accessToken, "fixture-new-access");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].accessToken, "fixture-new-access");
  assert.equal(clock.timers.size, 0);
});

test("one caller cancellation does not abort another caller's shared refresh", async () => {
  const clock = new RefreshClock();
  const updates = [];
  let resolveFetch;
  let upstreamSignal;
  let calls = 0;
  const runtime = loadRefreshRuntime({
    clock,
    update: async (tokens) => updates.push(tokens),
    fetch: (_url, options) => {
      calls += 1;
      upstreamSignal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const cancelledContext = refreshContext({ hasAuthJsSession: true });
  const survivingContext = refreshContext({ hasAuthJsSession: true });
  const caller = new AbortController();
  const cancelled = assert.rejects(
    runtime.rotateBackendTokens(cancelledContext, caller.signal),
    { name: "AbortError" },
  );
  const surviving = runtime.rotateBackendTokens(survivingContext);
  caller.abort();
  await cancelled;
  assert.equal(calls, 1);
  assert.equal(upstreamSignal.aborted, false);
  resolveFetch(refreshedResponse());
  await surviving;
  assert.equal(cancelledContext.rotatedTokens, null);
  assert.equal(survivingContext.accessToken, "fixture-new-access");
  assert.equal(updates.length, 1);
  assert.equal(clock.timers.size, 0);
});

test("an already-aborted caller does not start an orphaned shared refresh", async () => {
  const clock = new RefreshClock();
  let calls = 0;
  const runtime = loadRefreshRuntime({ clock, fetch: async () => { calls += 1; } });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(runtime.rotateBackendTokens(refreshContext(), caller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(clock.timers.size, 0);
});

test("failed refreshes preserve authentication errors and allow a later flight", async () => {
  const clock = new RefreshClock();
  let calls = 0;
  const runtime = loadRefreshRuntime({
    clock,
    fetch: async () => ++calls === 1
      ? Response.json({ detail: "Invalid or expired refresh token" }, { status: 401 })
      : refreshedResponse(),
  });
  await assert.rejects(runtime.rotateBackendTokens(refreshContext()), (error) =>
    error instanceof runtime.BackendRuntimeHttpError && error.status === 401,
  );
  assert.equal(clock.timers.size, 0);
  const context = refreshContext();
  await runtime.rotateBackendTokens(context);
  assert.equal(context.accessToken, "fixture-new-access");
  assert.equal(calls, 2);
  assert.equal(clock.timers.size, 0);
});

test("unrelated runtime reads retain their caller-owned deadlines", async () => {
  const clock = new RefreshClock();
  let resolveFetch;
  let receivedSignal;
  const runtime = loadRefreshRuntime({
    clock,
    fetch: (_url, options) => {
      receivedSignal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const pending = runtime.fetchBackendRuntimeJson("/fixture-long-read");
  clock.advance(60_000);
  assert.equal(clock.timers.size, 0);
  assert.equal(receivedSignal, undefined);
  resolveFetch(Response.json({ ok: true }));
  assert.deepEqual(await pending, { ok: true });
});
