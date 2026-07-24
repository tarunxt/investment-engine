import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadStatusModule() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunStatus.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenAutoRunStatus.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
  );
}

function createStatus(overrides = {}) {
  const { state: stateOverrides = {}, settings: settingsOverrides = {}, ...rest } =
    overrides;
  return {
    state: {
      running: true,
      paused: false,
      emergency_stopped: false,
      mode: "live-trading",
      status: "running",
      next_run_at: "2026-07-23T12:00:00+00:00",
      last_run_at: "2026-07-23T11:00:00+00:00",
      last_run_id: "run-1",
      ...stateOverrides,
    },
    settings: {
      auto_live_enabled: true,
      strategy_profile: "bullpen_console_top10",
      console_order_usd: 5,
      console_auto_start_at: "2026-07-23T12:00:00+00:00",
      console_auto_refresh_minutes: 60,
      ...settingsOverrides,
    },
    fetched_at: "2026-07-23T11:00:00+00:00",
    ...rest,
  };
}

function createEndpointStatus(overrides = {}) {
  const {
    configuration: configurationOverrides = {},
    scheduler: schedulerOverrides = {},
    ...rootOverrides
  } = overrides;
  return {
    source: "persisted",
    refreshed_at: "2026-07-23T11:00:00+00:00",
    configuration: {
      auto_live_enabled: true,
      strategy_profile: "bullpen_console_top10",
      console_order_usd: 5,
      console_auto_start_at: "2026-07-23T12:00:00+00:00",
      console_auto_refresh_minutes: 60,
      ...configurationOverrides,
    },
    scheduler: {
      running: true,
      paused: false,
      emergency_stopped: false,
      mode: "live-trading",
      status: "running",
      next_run_at: "2026-07-23T12:00:00+00:00",
      last_run_at: "2026-07-23T11:00:00+00:00",
      last_run_id: "run-1",
      ...schedulerOverrides,
    },
    ...rootOverrides,
  };
}

test("Bullpen auto-run status cache validates and renders the last known data as stale", async () => {
  const {
    BULLPEN_AUTO_RUN_STATUS_CACHE_KEY,
    getBullpenAutoRunStatusCacheKey,
    parseBullpenAutoRunStatusCache,
    readCachedBullpenAutoRunStatus,
    writeCachedBullpenAutoRunStatus,
  } = await loadStatusModule();
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const savedAt = 1_000;
  const status = createStatus();

  assert.equal(writeCachedBullpenAutoRunStatus(storage, status, savedAt), true);
  const fresh = readCachedBullpenAutoRunStatus(storage, {
    now: savedAt + 500,
    freshForMs: 1_000,
    maxAgeMs: 5_000,
  });
  assert.deepEqual(fresh?.data, status);
  assert.equal(fresh?.isStale, false);
  assert.equal(fresh?.ageMs, 500);

  const stale = readCachedBullpenAutoRunStatus(storage, {
    now: savedAt + 2_000,
    freshForMs: 1_000,
    maxAgeMs: 5_000,
  });
  assert.deepEqual(stale?.data, status);
  assert.equal(stale?.isStale, true);

  const expired = readCachedBullpenAutoRunStatus(storage, {
    now: savedAt + 5_001,
    maxAgeMs: 5_000,
  });
  assert.equal(expired, null);

  values.set(BULLPEN_AUTO_RUN_STATUS_CACHE_KEY, "not json");
  assert.equal(readCachedBullpenAutoRunStatus(storage), null);
  assert.equal(
    parseBullpenAutoRunStatusCache(
      JSON.stringify({ version: 999, savedAt, data: status }),
    ),
    null,
  );

  const scopedKey = getBullpenAutoRunStatusCacheKey(42);
  assert.equal(scopedKey, `${BULLPEN_AUTO_RUN_STATUS_CACHE_KEY}:42`);
  assert.equal(writeCachedBullpenAutoRunStatus(storage, status, savedAt, scopedKey), true);
  assert.deepEqual(
    readCachedBullpenAutoRunStatus(storage, { now: savedAt + 1 }, scopedKey)?.data,
    status,
  );
  assert.equal(getBullpenAutoRunStatusCacheKey(null), null);
});

test("Bullpen auto-run status rejects malformed API and cache payloads", async () => {
  const {
    getBullpenAutoRunStatusBadges,
    isBullpenAutoRunStatusData,
    normalizeBullpenAutoRunStatusData,
  } = await loadStatusModule();

  assert.deepEqual(
    normalizeBullpenAutoRunStatusData(createEndpointStatus()),
    createStatus(),
  );
  assert.deepEqual(
    getBullpenAutoRunStatusBadges(
      createStatus({
        state: {
          running: true,
          paused: false,
          emergency_stopped: true,
          mode: "live-trading",
          status: "paused",
        },
      }),
      "ready",
    ),
    {
      statusLabel: "Paused",
      modeLabel: "Live trading",
      isStale: false,
      isUpdating: false,
    },
  );
  assert.deepEqual(
    getBullpenAutoRunStatusBadges(
      createStatus({ state: { status: "error" } }),
      "ready",
    ),
    {
      statusLabel: "Enabled",
      modeLabel: "Live trading",
      isStale: true,
      isUpdating: false,
    },
  );
  assert.deepEqual(
    getBullpenAutoRunStatusBadges(
      createStatus({
        state: {
          running: false,
          status: "error",
          mode: "analysis-only",
        },
      }),
      "ready",
    ),
    {
      statusLabel: "Unavailable",
      modeLabel: "Analysis only",
      isStale: true,
      isUpdating: false,
    },
  );
  assert.equal(
    normalizeBullpenAutoRunStatusData(
      createEndpointStatus({
        scheduler: { running: true, paused: false, mode: "unknown" },
      }),
    ),
    null,
  );
  assert.equal(
    isBullpenAutoRunStatusData(
      createEndpointStatus({
        configuration: { auto_live_enabled: "true" },
      }),
    ),
    false,
  );
  assert.equal(normalizeBullpenAutoRunStatusData({ scheduler: {} }), null);
});

test("Bullpen auto-run status uses only a validated summary as its secondary semantic fallback", async () => {
  const { normalizeBullpenAutoRunStatusFromSummary } = await loadStatusModule();
  const summary = {
    state: {
      running: true,
      paused: false,
      emergency_stopped: false,
      mode: "live-trading",
      status: "running",
      next_run_at: "2026-07-23T12:00:00+00:00",
      last_run_at: "2026-07-23T11:00:00+00:00",
      last_run_id: "run-active",
      server_now: "2026-07-23T11:01:00+00:00",
    },
    settings: {
      auto_live_enabled: true,
      strategy_profile: "bullpen_console_top10",
      console_order_usd: 5,
      console_auto_start_at: "2026-07-23T12:00:00+00:00",
      console_auto_refresh_minutes: 60,
    },
    latest_run: {
      id: "run-active",
      status: "running",
    },
  };

  assert.deepEqual(
    normalizeBullpenAutoRunStatusFromSummary(summary),
    createStatus({
      state: {
        last_run_id: "run-active",
        active_run_id: "run-active",
        active_run_status: "running",
        server_now: "2026-07-23T11:01:00+00:00",
      },
      fetched_at: "2026-07-23T11:01:00+00:00",
    }),
  );
  assert.equal(
    normalizeBullpenAutoRunStatusFromSummary({
      ...summary,
      latest_run: { id: "run-complete", status: "completed" },
    })?.state.active_run_id,
    null,
  );
  assert.equal(
    normalizeBullpenAutoRunStatusFromSummary({
      ...summary,
      latest_run: { id: "run-skipped", status: "skipped" },
      recent_runs: [
        { id: "run-skipped", status: "skipped" },
        { id: "run-active", status: "confirming" },
      ],
    })?.state.active_run_id,
    "run-active",
  );
  assert.equal(
    normalizeBullpenAutoRunStatusFromSummary({
      ...summary,
      state: { ...summary.state, running: "true" },
    }),
    null,
  );
});

test("Bullpen auto-run status component bounds automatic retries and records semantic fallbacks", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /AUTO_RUN_STATUS_MAX_AUTOMATIC_RETRIES = 3/);
  assert.match(source, /normalizeBullpenAutoRunStatusFromSummary/);
  assert.match(source, /approach: "validated-summary"/);
  assert.match(source, /approach: "last-known-good-cache"/);
  assert.match(source, /Automatic status retries are exhausted/);
});

test("Bullpen auto-run status deduplicates concurrent requests and releases after settlement", async () => {
  const { createBullpenAutoRunRequestDeduper } = await loadStatusModule();
  const dedupe = createBullpenAutoRunRequestDeduper();
  let calls = 0;
  let resolveRequest;
  const load = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };

  const first = dedupe(load);
  const second = dedupe(load);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  resolveRequest("first");
  assert.equal(await first, "first");

  const third = dedupe(async () => {
    calls += 1;
    return "second";
  });
  assert.equal(await third, "second");
  assert.equal(calls, 2);
});

test("Bullpen auto-run shared status requests survive Strict Mode remounts and abort after the final subscriber", async () => {
  const { createAbortableBullpenAutoRunRequestDeduper } = await loadStatusModule();
  let calls = 0;
  let aborts = 0;
  let resolveRequest;
  const dedupe = createAbortableBullpenAutoRunRequestDeduper((signal) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      resolveRequest = resolve;
      signal.addEventListener(
        "abort",
        () => {
          aborts += 1;
          reject(new DOMException("Request aborted", "AbortError"));
        },
        { once: true },
      );
    });
  });

  const firstController = new AbortController();
  const first = dedupe(firstController.signal);
  await Promise.resolve();
  assert.equal(calls, 1);

  // Strict Mode cleans up then mounts again synchronously. The microtask grace
  // period keeps the real request alive and the remount joins it.
  firstController.abort();
  const secondController = new AbortController();
  const second = dedupe(secondController.signal);
  await assert.rejects(first, { name: "AbortError" });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(aborts, 0);

  resolveRequest("shared-result");
  assert.equal(await second, "shared-result");

  const finalController = new AbortController();
  const finalSubscriber = dedupe(finalController.signal);
  await Promise.resolve();
  assert.equal(calls, 2);
  finalController.abort();
  await assert.rejects(finalSubscriber, { name: "AbortError" });
  await Promise.resolve();
  assert.equal(aborts, 1);
});

test("Bullpen auto-run badges use explicit finite failure and retry labels", async () => {
  const { getBullpenAutoRunStatusBadges } = await loadStatusModule();

  assert.deepEqual(
    getBullpenAutoRunStatusBadges(createStatus(), "ready"),
    {
      statusLabel: "Enabled",
      modeLabel: "Live trading",
      isStale: false,
      isUpdating: false,
    },
  );
  assert.deepEqual(
    getBullpenAutoRunStatusBadges(
      createStatus({
        state: { running: false, paused: true, mode: "analysis-only" },
      }),
      "ready",
    ),
    {
      statusLabel: "Paused",
      modeLabel: "Analysis only",
      isStale: false,
      isUpdating: false,
    },
  );
  assert.deepEqual(
    getBullpenAutoRunStatusBadges(
      createStatus({
        settings: { auto_live_enabled: false },
        state: { running: false, paused: false, mode: "dry-run" },
      }),
      "ready",
    ),
    {
      statusLabel: "Disabled",
      modeLabel: "Dry run",
      isStale: false,
      isUpdating: false,
    },
  );
  assert.deepEqual(getBullpenAutoRunStatusBadges(null, "timeout"), {
    statusLabel: "Unavailable",
    modeLabel: "Check failed",
    isStale: false,
    isUpdating: false,
  });
  assert.deepEqual(getBullpenAutoRunStatusBadges(null, "loading"), {
    statusLabel: null,
    modeLabel: null,
    isStale: false,
    isUpdating: true,
  });
  assert.deepEqual(getBullpenAutoRunStatusBadges(null, "retrying"), {
    statusLabel: "Retrying",
    modeLabel: "Retrying",
    isStale: false,
    isUpdating: true,
  });
  assert.deepEqual(
    getBullpenAutoRunStatusBadges(createStatus(), "error"),
    {
      statusLabel: "Enabled",
      modeLabel: "Live trading",
      isStale: true,
      isUpdating: false,
    },
  );
});

test("Bullpen auto-run retry delay is deterministic, exponential, and capped", async () => {
  const { getBullpenAutoRunStatusRetryDelay } = await loadStatusModule();

  assert.deepEqual(
    [0, 1, 2, 3, 4, 8].map((attempt) =>
      getBullpenAutoRunStatusRetryDelay(attempt),
    ),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  );
  assert.equal(
    getBullpenAutoRunStatusRetryDelay(2, {
      baseDelayMs: 250,
      maxDelayMs: 750,
    }),
    750,
  );
});

test("Bullpen auto-run polling is limited to visible active runs after initial status resolves", async () => {
  const {
    getBullpenAutoRunActiveRunId,
    isBullpenAutoRunActive,
    isBullpenAutoRunProgressActive,
    isBullpenAutoRunPageVisible,
    isBullpenAutoRunSchedulerEnabled,
    shouldPollBullpenAutoRun,
  } = await loadStatusModule();

  assert.equal(isBullpenAutoRunActive("running"), true);
  assert.equal(isBullpenAutoRunActive("queued"), true);
  assert.equal(isBullpenAutoRunActive("completed"), false);
  assert.equal(isBullpenAutoRunPageVisible("visible"), true);
  assert.equal(isBullpenAutoRunPageVisible("hidden"), false);

  const schedulerOnly = createStatus({
    state: {
      running: true,
      paused: false,
      emergency_stopped: false,
      status: "running",
      active_run_id: null,
      active_run_status: null,
    },
  });
  assert.equal(isBullpenAutoRunSchedulerEnabled(schedulerOnly), true);
  assert.equal(getBullpenAutoRunActiveRunId(schedulerOnly), null);
  assert.equal(isBullpenAutoRunProgressActive(schedulerOnly), false);

  const schedulerWithHistoricalError = createStatus({
    state: {
      running: true,
      paused: false,
      emergency_stopped: false,
      status: "error",
    },
  });
  assert.equal(
    isBullpenAutoRunSchedulerEnabled(schedulerWithHistoricalError),
    true,
  );

  const runInProgress = createStatus({
    state: {
      active_run_id: "run-active",
      active_run_status: "confirming",
    },
  });
  assert.equal(getBullpenAutoRunActiveRunId(runInProgress), "run-active");
  assert.equal(isBullpenAutoRunProgressActive(runInProgress), true);

  assert.equal(
    shouldPollBullpenAutoRun({
      visibilityState: "visible",
      initialLoadState: "ready",
      runStatus: "running",
      requestInFlight: false,
    }),
    true,
  );
  assert.equal(
    shouldPollBullpenAutoRun({
      visibilityState: "hidden",
      initialLoadState: "ready",
      runStatus: "running",
    }),
    false,
  );
  assert.equal(
    shouldPollBullpenAutoRun({
      visibilityState: "visible",
      initialLoadState: "loading",
      runStatus: "running",
    }),
    false,
  );
  assert.equal(
    shouldPollBullpenAutoRun({
      visibilityState: "visible",
      initialLoadState: "ready",
      runStatus: "completed",
    }),
    false,
  );
  assert.equal(
    shouldPollBullpenAutoRun({
      visibilityState: "visible",
      initialLoadState: "ready",
      runStatus: "confirming",
      requestInFlight: true,
    }),
    false,
  );
});
