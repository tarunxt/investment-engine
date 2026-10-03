import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function compile(source) {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  return result.outputText;
}
const helperModule = { exports: {} };
new Function("exports", "module", compile(readFileSync(new URL("../lib/autoRebalanceAudit.ts", import.meta.url), "utf8")))(helperModule.exports, helperModule);
const { AutoRebalanceAuditSession, assertAutoRebalanceRunMetadata, autoRebalanceAuditKey, restoreAutoRebalanceAuditState } = helperModule.exports;
const rebalanceSource = readFileSync(new URL("../lib/rebalance.ts", import.meta.url), "utf8");
const rebalanceAst = ts.createSourceFile("rebalance.ts", rebalanceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const holdingsGuard = rebalanceAst.statements.find((node) => node.name?.getText(rebalanceAst) === "assertIndmoneyHoldingsSnapshot");
assert.ok(holdingsGuard, "use the real holdings guard in the extracted workflow");
const holdingsExports = {};
new Function("exports", compile(holdingsGuard.getText(rebalanceAst)))(holdingsExports);
const { assertIndmoneyHoldingsSnapshot } = holdingsExports;
const holdingsSnapshot = {
  parse_status: "parsed", reported_holdings_count: 1, captured_at: "2025-01-15T12:00:00Z",
  holdings: [{ symbol: "ABC", quantity: 0.125 }],
};
const workflowSource = readFileSync(new URL("../app/console/dashboard/_components/RebalanceWorkflowSections.tsx", import.meta.url), "utf8");
function extract(start, end) {
  const index = workflowSource.indexOf(start);
  const finish = workflowSource.indexOf(end, index);
  assert.ok(index >= 0 && finish > index);
  return workflowSource.slice(index, finish);
}
const callbacks = extract("  const getAuditSession = useCallback(", "  useEffect(() => {");
const workflow = extract("  const runWorkflow = useCallback(", "  const syncPortfolioNow = useCallback(");
const executable = compile(`${callbacks}\n${workflow}\nreturn { getAuditSession, recordAutoRebalanceStage, markCompleted, runWorkflow };`);
const stages = ["sync", "threats", "swing", "rebalance", "technical", "actionables"];
const metadata = (portfolio = "india", sequence = 42) => ({ auto_rebalance_portfolio: portfolio, auto_rebalance_sequence: sequence, auto_rebalance_label: `${portfolio} ${sequence}` });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
async function until(check) {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), "expected asynchronous checkpoint was reached");
}

function harness({ intercept, read, email, reserve, snapshot = holdingsSnapshot, selection = ["swing", "actionables"] } = {}) {
  const durable = new Map();
  const auditWrites = [];
  const emails = [];
  const modelCalls = [];
  const delays = [];
  const timers = [];
  const updates = [];
  const alerts = [];
  const view = { audits: {}, warnings: {}, running: null, states: Object.fromEntries(["zerodha", "indmoneyUs"].map((p) => [p, Object.fromEntries(stages.map((stage) => [stage, { state: "idle" }]))])) };
  const set = (key) => (value) => { view[key] = typeof value === "function" ? value(view[key]) : value; };
  const active = { current: {} };
  const sessions = { current: {} };
  const execution = { current: false };
  const cancel = { current: false };
  const pause = { current: false };
  const apiService = {
    updateAutoRebalanceStage: async (portfolio, sequence, stage, payload) => {
      const args = { portfolio, sequence, stage, payload: structuredClone(payload) };
      auditWrites.push(args);
      const override = await intercept?.(args, auditWrites);
      if (override) return override;
      const existing = durable.get(`${portfolio}:${sequence}:${stage}`);
      const saved = existing && ["completed", "partial", "failed", "skipped", "paused", "cancelled", "interrupted"].includes(existing.status)
        ? existing
        : { stage, ...payload };
      durable.set(`${portfolio}:${sequence}:${stage}`, saved);
      return saved;
    },
    getAutoRebalanceHistoryDetail: async (portfolio, sequence) => {
      if (read) return read({ portfolio, sequence, durable });
      const savedStages = stages.map((stage) => durable.get(`${portfolio}:${sequence}:${stage}`)).filter(Boolean);
      return { portfolio, sequence, status: savedStages.length === 6 && savedStages.every((stage) => ["completed", "partial", "skipped"].includes(stage.status)) ? "completed" : "processing", stages: savedStages };
    },
    queueAutoRebalanceCompletionEmail: async (payload) => {
      emails.push(payload);
      return email?.(payload);
    },
    getProviders: async () => [{ provider: "existing", model: "chosen" }],
    indmoneyUsPortfolioOverview: async () => ({ latest: snapshot }),
    indmoneyUsCreatePortfolioSnapshot: async () => snapshot,
    createRun: async (payload) => { modelCalls.push(payload); return { id: modelCalls.length }; },
  };
  const bindings = {
    useCallback: (fn) => fn, AutoRebalanceAuditSession, assertAutoRebalanceRunMetadata, autoRebalanceAuditKey, assertIndmoneyHoldingsSnapshot,
    activeAutoRebalanceMetadataRef: active, auditSessionsRef: sessions,
    apiService, sleep: async (ms) => { delays.push(ms); },
    setAuditStates: set("audits"), setCompletionEmailWarnings: set("warnings"), setStates: set("states"),
    updateStage: (portfolio, stage, info) => { updates.push({ portfolio, stage, info }); view.states[portfolio][stage] = { ...view.states[portfolio][stage], ...info }; },
    withInrCost: (info) => info, usdInrRate: 1, STAGE_ORDER: stages,
    specificMode: { zerodha: true, indmoneyUs: true },
    selectedStages: { zerodha: new Set(selection), indmoneyUs: new Set(selection) },
    selectedInputs: Object.fromEntries(["zerodha", "indmoneyUs"].map((p) => [p, Object.fromEntries(stages.map((stage) => [stage, new Set([`${stage}:next`])]))])),
    isWorkflowExecutingRef: execution, activeExecutionRefsRef: { current: [] },
    cancelRequestedRef: cancel, pauseRequestedRef: pause,
    setRunningPortfolio: set("running"), setWorkflowPaused: () => {},
    reserveAutoRebalanceRunMetadata: reserve ?? (async (p) => metadata(p === "zerodha" ? "india" : "indmoney_us")),
    setActiveAutoRebalanceMetadata: () => {}, setSpecificMode: () => {}, setSelectedStages: () => {}, setSelectedInputs: () => {}, setLastAutoRebalanceCosts: () => {},
    buildZerodhaPopupFeatures: () => "", ensureZerodhaConnectedForSync: async () => {},
    onDashboardRefresh: async () => {}, waitForRunWithStageHandling: async (_, __, id) => ({ id, status: "completed" }),
    retryWorkflowRead: (read) => read(),
    getSavedStageTargets: () => [{ provider: "existing", model: "chosen", sample_count: 3 }],
    buildSwingTradePrompt: () => "unchanged strategy", getSwingTradeDefaultInvestmentAmount: () => "existing amount", getSwingTradeDefaultExportSheetName: () => "existing sheet",
    getSelectedThreatJobIds: () => [], deduplicateThreatStageInputs: (input) => input,
    buildRunPayload: (payload) => payload, summarizeRun: () => ({ runStatus: "completed" }), getRunProgress: () => ({ completedLlms: 1, totalLlms: 1 }), countUniqueStocksFromRun: () => 1,
    getStageTileLabel: (stage) => stage, normalizeError: (error) => error.message,
    RecordedWorkflowStageFailure: class extends Error {}, WORKFLOW_COMPLETION_RESET_DELAY_MS: 1,
    getWorkflowRunCost: () => 0,
    window: { setTimeout: (fn) => { timers.push(fn); }, dispatchEvent: () => {}, alert: (message) => { alerts.push(message); } },
    CustomEvent: class {}, console: { error: () => {} },
  };
  return { ...new Function(...Object.keys(bindings), executable)(...Object.values(bindings)), view, active, sessions, execution, cancel, pause, auditWrites, emails, modelCalls, delays, timers, durable, updates, alerts };
}

for (const rejectedStage of ["sync", "actionables"]) {
  test(`actual workflow retains model output when ${rejectedStage} audit never persists`, async () => {
    const h = harness({ intercept: async ({ stage, payload }) => {
      if (stage === rejectedStage && ["skipped", "completed"].includes(payload.status)) throw new Error("audit storage unavailable");
    } });
    await h.runWorkflow("zerodha");
    assert.equal(h.view.audits.zerodha.status, "failed");
    assert.equal(h.modelCalls.length, 1, "audit failure must not repeat paid model work");
    assert.deepEqual(h.modelCalls[0].targets, [{ provider: "existing", model: "chosen", sample_count: 3 }]);
    assert.equal(h.modelCalls[0].prompt, "unchanged strategy");
    assert.equal(h.view.states.zerodha.swing.state, "completed");
    assert.equal(h.view.states.zerodha.actionables.state, "completed");
    assert.equal(h.updates.filter(({ info }) => info.state === "failed").length, 0, "audit failure is not an LLM failure");
    assert.equal(h.emails.length, 0);
    assert.equal(h.timers.length, 0, "unsaved workflow does not reset to a successful idle state");
    const failures = h.auditWrites.filter(({ stage, payload }) => stage === rejectedStage && ["skipped", "completed"].includes(payload.status));
    assert.equal(failures.length, 3);
    assert.deepEqual(failures[0], failures[2], "retry preserves identity and metadata");
    assert.equal(h.execution.current, false);
  });
}

test("actual markCompleted returns persistence and keeps output available while audit is pending", async () => {
  const block = deferred();
  const h = harness({ intercept: () => block.promise });
  h.active.current.zerodha = metadata();
  const completion = h.markCompleted("zerodha", "actionables", { runStatus: "fresh data loaded" });
  assert.equal(typeof completion.then, "function");
  await until(() => h.auditWrites.length === 1);
  assert.equal(h.view.states.zerodha.actionables.state, "completed");
  assert.equal(h.view.audits.zerodha.status, "pending");
  block.resolve();
  assert.deepEqual(await completion, { saved: true });
});

test("actual workflow waits for last stage and durable history before email", async () => {
  const lastWrite = deferred();
  const read = deferred();
  const h = harness({ intercept: ({ stage, payload }) => stage === "actionables" && payload.status === "completed" ? lastWrite.promise : undefined, read: () => read.promise });
  const running = h.runWorkflow("zerodha");
  await until(() => h.auditWrites.some(({ stage, payload }) => stage === "actionables" && payload.status === "completed"));
  assert.equal(h.emails.length, 0);
  assert.equal(h.view.audits.zerodha.status, "pending");
  lastWrite.resolve();
  await until(() => h.durable.get("india:42:actionables")?.status === "completed");
  assert.equal(h.emails.length, 0);
  read.resolve({ portfolio: "india", sequence: 42, status: "completed", stages: [...h.durable.values()] });
  await running;
  assert.equal(h.emails.length, 1);
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.timers.length, 1);
  assert.equal(h.modelCalls.length, 1);
});

test("actual workflow retries only identical metadata and queues email once after recovery", async () => {
  let attempts = 0;
  const h = harness({ intercept: async ({ stage, payload }) => {
    if (stage === "actionables" && payload.status === "completed" && ++attempts < 3) throw new Error("temporary failure");
  } });
  await h.runWorkflow("zerodha");
  assert.equal(attempts, 3);
  assert.equal(h.modelCalls.length, 1);
  assert.equal(h.emails.length, 1);
  assert.deepEqual(h.delays, [500, 1000]);
});

test("a lost final response reconciles committed audit without repeating model work", async () => {
  let h;
  h = harness({ intercept: async ({ portfolio, sequence, stage, payload }) => {
    if (stage === "actionables" && payload.status === "completed") {
      h.durable.set(`${portfolio}:${sequence}:${stage}`, { stage, ...payload });
      throw new Error("response lost after commit");
    }
  } });
  await h.runWorkflow("zerodha");
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.emails.length, 1);
  assert.equal(h.modelCalls.length, 1);
});

for (const mismatch of ["sequence", "portfolio", "parent", "stage", "run", "summary"]) {
  test(`durable ${mismatch} mismatch blocks actual workflow email`, async () => {
    const h = harness({ read: ({ durable }) => ({
      portfolio: mismatch === "portfolio" ? "indmoney_us" : "india",
      sequence: mismatch === "sequence" ? 41 : 42,
      status: mismatch === "parent" ? "queued" : "completed",
      stages: [...durable.values()].map((saved) => saved.stage === "swing" ? { ...saved, ...(mismatch === "stage" ? { status: "processing" } : {}), ...(mismatch === "run" ? { run_id: 999 } : {}), ...(mismatch === "summary" ? { summary: {} } : {}) } : saved),
    }) });
    await h.runWorkflow("zerodha");
    assert.equal(h.emails.length, 0);
    assert.equal(h.view.audits.zerodha.status, "failed");
    assert.equal(h.modelCalls.length, 1);
  });
}

test("exhausted history reads preserve outputs and withhold completion email", async () => {
  let reads = 0;
  const h = harness({ read: () => { reads += 1; throw new Error("history unavailable"); } });
  await h.runWorkflow("zerodha");
  assert.equal(reads, 3);
  assert.equal(h.emails.length, 0);
  assert.equal(h.view.audits.zerodha.status, "failed");
  assert.match(h.view.audits.zerodha.message, /history unavailable/);
  assert.equal(h.view.states.zerodha.actionables.state, "completed");
  assert.equal(h.modelCalls.length, 1);
});

test("late old-run persistence cannot update a newer run or another portfolio", async () => {
  const oldWrite = deferred();
  const h = harness({ intercept: ({ sequence }) => sequence === 42 ? oldWrite.promise : undefined });
  h.active.current.zerodha = metadata();
  const old = h.markCompleted("zerodha", "swing", { lastRunId: 11 });
  await until(() => h.auditWrites.length === 1);
  h.active.current.zerodha = metadata("india", 43);
  await h.markCompleted("zerodha", "swing", { lastRunId: 22 });
  h.active.current.indmoneyUs = metadata("indmoney_us", 43);
  await h.markCompleted("indmoneyUs", "actionables", {});
  oldWrite.reject(new Error("old run unavailable"));
  await old;
  assert.equal(h.view.audits.zerodha.key, "india:43");
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.view.audits.indmoneyUs.key, "indmoney_us:43");
  assert.equal(h.view.audits.indmoneyUs.status, "saved");
  assert.deepEqual(h.auditWrites.filter(({ sequence }) => sequence === 42).map(({ portfolio, payload }) => [portfolio, payload.run_id]), [["india", 11], ["india", 11], ["india", 11]]);
});

test("serialized stage writes prevent a late processing write from overtaking completion", async () => {
  const processing = deferred();
  const h = harness({ intercept: ({ payload }) => payload.status === "processing" ? processing.promise : undefined });
  h.active.current.zerodha = metadata();
  const first = h.recordAutoRebalanceStage("zerodha", "swing", "processing");
  const last = h.markCompleted("zerodha", "swing", { lastRunId: 1 });
  await until(() => h.auditWrites.length === 1);
  assert.equal(h.auditWrites[0].payload.status, "processing");
  processing.resolve();
  await Promise.all([first, last]);
  assert.deepEqual(h.auditWrites.map(({ payload }) => payload.status), ["processing", "completed"]);
  assert.equal(h.durable.get("india:42:swing").status, "completed");
});

test("terminal metadata preserves the job link even when its earlier processing write failed", async () => {
  const h = harness({ intercept: ({ payload }) => {
    if (payload.status === "processing") throw new Error("processing audit unavailable");
  } });
  h.active.current.zerodha = metadata();
  const processing = await h.recordAutoRebalanceStage("zerodha", "threats", "processing", {}, { jobId: 42 });
  assert.equal(processing.saved, false);
  const completed = await h.markCompleted("zerodha", "threats", { runStatus: "completed", totalLlms: 1 });
  assert.equal(completed.saved, true);
  assert.equal(h.durable.get("india:42:threats").job_id, 42);
  assert.equal(h.auditWrites.length, 4);
  assert.equal(h.modelCalls.length, 0);
});

test("cancel during durable reconciliation cannot queue completion email", async () => {
  const blocked = deferred();
  const h = harness({ read: () => blocked.promise });
  const running = h.runWorkflow("zerodha");
  await until(() => h.durable.get("india:42:actionables")?.status === "completed");
  h.cancel.current = true;
  blocked.resolve({ portfolio: "india", sequence: 42, status: "completed", stages: [...h.durable.values()] });
  await running;
  assert.equal(h.emails.length, 0);
});

test("a second start and a previous run's reset timer cannot mutate an active run", async () => {
  const h = harness();
  await h.runWorkflow("zerodha");
  const before = structuredClone(h.view.states);
  h.execution.current = true;
  h.view.running = null; // Kill clears this while the original work unwinds.
  await h.runWorkflow("indmoneyUs");
  assert.equal(h.modelCalls.length, 1);
  h.timers[0]();
  assert.deepEqual(h.view.states, before);
});

test("email failure is visible and does not turn completed model work into a failed stage", async () => {
  const h = harness({ email: async () => { throw new Error("email acknowledgement unavailable"); } });
  await h.runWorkflow("zerodha");
  assert.match(h.view.warnings.zerodha, /Completion email was not confirmed/);
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.view.states.zerodha.actionables.state, "completed");
  assert.equal(h.modelCalls.length, 1);
});

test("actual workflow card renders pending and failed history independently of output controls", () => {
  const source = compile(`${extract("  const renderSectionCard =", "  const zerodhaSection =")}\nreturn renderSectionCard;`);
  const workflowStates = Object.fromEntries(stages.map((stage) => [stage, { state: "completed" }]));
  for (const status of ["pending", "failed"]) {
    const bindings = {
      exports: {},
      require: (name) => { assert.equal(name, "react/jsx-runtime"); return jsxRuntime; },
      auditStates: { zerodha: { key: "india:42", label: "India 42", status, message: "History not acknowledged" } },
      completionEmailWarnings: {}, runningPortfolio: null, states: { zerodha: workflowStates },
      hasActiveWorkflowStage: () => false, getQueuedStages: () => new Set(),
      specificMode: { zerodha: false }, selectedStages: { zerodha: new Set() },
      shouldShowQuotaLlmSwitchWarning: () => false, Link: "a", History: "span", Loader2: "span", Play: "span", Button: "button",
      URLs: { routes: { console: { autoRebalanceRuns: () => "/console/auto-rebalance-runs?portfolio=zerodha" } } },
      formatTimestamp: () => "03 Oct", lastRunByPortfolio: { zerodha: null }, isBusy: false, STAGE_ORDER: stages, now: 0,
      WorkflowStageTile: ({ stage }) => createElement("button", null, `View output ${stage}`),
      RebalanceStockFlowTrigger: () => null, getWorkflowRunDuration: () => null,
      getWorkflowRunCost: () => 0, formatInrCost: () => "0", usdInrRate: 1, lastAutoRebalanceCosts: { zerodha: 0 },
    };
    const card = new Function(...Object.keys(bindings), source)(...Object.values(bindings));
    const html = renderToStaticMarkup(card({ portfolio: "zerodha", title: "Run Zerodha Auto-Rebalance", buttonLabel: "Run" }));
    assert.match(html, status === "pending" ? /role="status"/ : /role="alert"/);
    assert.match(html, /Completed outputs remain available/);
    if (status === "failed") {
      assert.match(html, /completion email has not been queued/);
      assert.match(html, /Check saved run history/);
    }
    assert.match(html, /View output actionables/);
    assert.match(html, /View output swing/);
  }
});

test("reload makes unacknowledged history visible without replaying past workflows", () => {
  const pending = { key: "india:42", label: "India 42", status: "pending", pending: 2, message: null };
  const restored = restoreAutoRebalanceAuditState(pending);
  assert.equal(restored.status, "failed");
  assert.equal(restored.pending, 0);
  assert.equal(restored.key, pending.key);
  assert.match(restored.message, /previous browser session/);
  assert.equal(pending.status, "pending", "restoration does not rewrite the saved source");
  const saved = { ...pending, status: "saved", pending: 0 };
  assert.equal(restoreAutoRebalanceAuditState(saved), saved);
  for (const invalid of [null, undefined, "pending", {}, { ...pending, label: null }, { ...pending, pending: -1 }]) {
    assert.equal(restoreAutoRebalanceAuditState(invalid), null, "malformed cached audit cannot break output rendering");
  }
});

test("malformed successful reservations cannot reach audit or model APIs and release startup state", async () => {
  const invalidReservations = [
    undefined, null, {},
    { ...metadata(), auto_rebalance_sequence: undefined },
    { ...metadata(), auto_rebalance_sequence: "42" },
    { ...metadata(), auto_rebalance_sequence: 0 },
    { ...metadata(), auto_rebalance_sequence: -1 },
    { ...metadata(), auto_rebalance_sequence: 1.5 },
    { ...metadata(), auto_rebalance_sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...metadata(), auto_rebalance_portfolio: "indmoney_us" },
    { ...metadata(), auto_rebalance_label: " " },
  ];
  for (const invalid of invalidReservations) {
    const h = harness({ reserve: async () => invalid });
    await h.runWorkflow("zerodha");
    assert.equal(h.modelCalls.length, 0);
    assert.equal(h.auditWrites.length, 0);
    assert.equal(h.emails.length, 0);
    assert.equal(h.execution.current, false);
    assert.equal(h.view.running, null);
    assert.equal(h.view.states.zerodha.swing.runStatus, "start failed");
    assert.match(h.alerts[0], /invalid auto-rebalance reservation/);
    assert.deepEqual(h.active.current, {});
  }
});

test("pause after a completed swing records the next selected unstarted stage without changing completed output", async () => {
  let h;
  h = harness({ intercept: ({ stage, payload }) => {
    if (stage === "swing" && payload.status === "completed") h.pause.current = true;
  } });
  await h.runWorkflow("zerodha");
  const paused = h.auditWrites.filter(({ payload }) => payload.status === "paused");
  assert.equal(paused.length, 1, "the valid pause does not retry a terminal-stage conflict");
  assert.equal(paused[0].stage, "actionables");
  assert.equal(h.durable.get("india:42:swing").status, "completed");
  assert.equal(h.durable.get("india:42:actionables").status, "paused");
  assert.equal(h.view.states.zerodha.swing.state, "completed");
  assert.equal(h.view.states.zerodha.actionables.runStatus, "Paused before this stage");
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.modelCalls.length, 1);
  assert.equal(h.emails.length, 0);
});

test("pause after sync clears the premarked next stage without launching its model", async () => {
  let h;
  h = harness({ selection: ["sync", "swing", "actionables"], intercept: ({ stage, payload }) => {
    if (stage === "sync" && payload.status === "completed") h.pause.current = true;
  } });
  await h.runWorkflow("indmoneyUs");
  assert.equal(h.durable.get("indmoney_us:42:sync").status, "completed");
  assert.equal(h.durable.get("indmoney_us:42:swing").status, "paused");
  assert.equal(h.view.states.indmoneyUs.swing.state, "idle");
  assert.equal(h.auditWrites.filter(({ payload }) => payload.status === "paused").length, 1);
  assert.equal(h.view.audits.indmoneyUs.status, "saved");
  assert.equal(h.modelCalls.length, 0);
  assert.equal(h.emails.length, 0);
});

test("INDmoney's real holdings guard blocks invalid pasted and saved snapshots before models or a completed sync audit", async () => {
  for (const snapshot of [null, { parse_status: "unparsed", holdings: [] },
    { ...holdingsSnapshot, reported_holdings_count: 2 },
    { ...holdingsSnapshot, holdings: [{ symbol: "ABC", quantity: null }] }]) {
    for (const pastedPayload of [undefined, { source_text: "synthetic invalid holdings" }]) {
      const h = harness({ snapshot, selection: ["sync", "swing", "actionables"] });
      await h.runWorkflow("indmoneyUs", pastedPayload);
      assert.equal(h.modelCalls.length, 0);
      assert.equal(h.emails.length, 0);
      assert.equal(h.auditWrites.some(({ stage, payload }) => stage === "sync" && payload.status === "completed"), false);
      assert.equal(h.durable.get("indmoney_us:42:sync").status, "failed");
      assert.match(h.view.states.indmoneyUs.sync.error, /My US Stocks/);
    }
  }
});

test("pause after the last selected stage finishes metadata without a false terminal-stage pause", async () => {
  let h;
  h = harness({ selection: ["swing"], intercept: ({ stage, payload }) => {
    if (stage === "swing" && payload.status === "completed") h.pause.current = true;
  } });
  await h.runWorkflow("zerodha");
  assert.equal(h.auditWrites.filter(({ payload }) => payload.status === "paused").length, 0);
  assert.equal(h.durable.get("india:42:actionables").status, "skipped");
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.modelCalls.length, 1);
  assert.equal(h.emails.length, 0);
});

test("kill while reservation is pending cannot start model work after reservation resolves", async () => {
  const reservation = deferred();
  const h = harness({ reserve: () => reservation.promise });
  const running = h.runWorkflow("zerodha");
  await until(() => h.execution.current);
  h.cancel.current = true;
  reservation.resolve(metadata());
  await running;
  assert.equal(h.modelCalls.length, 0);
  assert.equal(h.emails.length, 0);
  assert.equal(h.auditWrites.filter(({ payload }) => payload.status === "cancelled").length, 1);
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.execution.current, false);
});

test("kill during stage audit records cancellation on an unstarted stage and preserves completed output", async () => {
  let h;
  h = harness({ intercept: ({ stage, payload }) => {
    if (stage === "swing" && payload.status === "completed") h.cancel.current = true;
  } });
  await h.runWorkflow("zerodha");
  assert.equal(h.durable.get("india:42:swing").status, "completed");
  const cancelled = h.auditWrites.filter(({ payload }) => payload.status === "cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].stage, "rebalance");
  assert.equal(h.view.states.zerodha.swing.state, "completed");
  assert.equal(h.view.audits.zerodha.status, "saved");
  assert.equal(h.emails.length, 0);
  assert.equal(h.modelCalls.length, 1);
});
