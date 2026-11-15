import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const base = '../app/console/trading-bots/bullpen-ai-auto-live/_components/';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read(`${base}BullpenAiAutoLiveConsole.tsx`);
const ast = ts.createSourceFile('console.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function findFunction(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `Missing function ${name}`);
  return found.getText(ast);
}

function loadFunction(name, bindings) {
  const loaded = { exports: {} };
  new Function('exports', 'module', ...Object.keys(bindings), compile(`${findFunction(name)}\nexport { ${name} };`))(
    loaded.exports, loaded, ...Object.values(bindings),
  );
  return loaded.exports[name];
}

function loadRequest(apiService) {
  return loadFunction('requestDashboard', {
    apiService,
    DASHBOARD_READ_TIMEOUT_MS: 20_000,
    URLs: { bullpenAutoLive: { state: () => '/polymarket/auto-live/state' } },
    labelize: (value) => value,
    formatDashboardIssue: (label, error) => `${label}: ${error.message}`,
    buildPartialSummary: (state) => ({ state, settings: {}, recent_runs: [], recent_decisions: [] }),
  });
}

function snapshot() {
  return {
    state: { status: 'idle' },
    settings: { console_llm_prompt_template: null },
    latest_run: { id: 'run-1' },
    recent_runs: [{ id: 'run-1' }],
    recent_decisions: [{ id: 'decision-1', run_id: 'run-1' }],
    sections: {},
    degraded_sections: [],
  };
}

test('legacy display reads only the passive dashboard projection with explicit deadline and cancellation', async () => {
  const controller = new AbortController();
  const saved = snapshot();
  let calls = 0;
  const api = {
    getBullpenAutoLiveDashboardSummary: async (options) => {
      calls += 1;
      assert.equal(options.timeoutMs, 20_000);
      assert.equal(options.signal, controller.signal);
      return saved;
    },
  };
  const result = await loadRequest(api)(controller.signal);
  assert.equal(calls, 1);
  assert.equal(result.summary, saved);
  assert.deepEqual(result.issues, []);
  assert.equal(result.hasSettings, true);
  assert.doesNotMatch(findFunction('requestDashboard'), /getBullpenAutoLive(?:Summary|Decisions|Runs|Settings)\(/);
});

test('stale and degraded projection sections remain visible without discarding successful data', async () => {
  const saved = snapshot();
  saved.degraded_sections = ['workflow'];
  saved.sections = {
    workflow: { status: 'degraded', detail: 'Open run detail for complete frozen evidence.' },
    settings: { status: 'stale', detail: 'Settings projection is stale.' },
  };
  const result = await loadRequest({ getBullpenAutoLiveDashboardSummary: async () => saved })(new AbortController().signal);
  assert.equal(result.summary, saved);
  assert.deepEqual(result.issues, ['workflow: Open run detail for complete frozen evidence.', 'settings: Settings projection is stale.']);
  assert.equal(result.hasSettings, false);
});

test('summary failure falls back only to passive state and keeps the editor unavailable', async () => {
  const controller = new AbortController();
  const state = { status: 'paused' };
  const result = await loadRequest({
    getBullpenAutoLiveDashboardSummary: async () => { throw new Error('Summary delayed'); },
    get: async (url, options) => {
      assert.equal(url, '/polymarket/auto-live/state');
      assert.equal(options.timeoutMs, 20_000);
      assert.equal(options.signal, controller.signal);
      return state;
    },
  })(controller.signal);
  assert.equal(result.summary.state, state);
  assert.equal(result.hasSettings, false);
  assert.deepEqual(result.issues, ['Summary: Summary delayed']);
});

test('both display failures stay explicit instead of producing a synthetic successful summary', async () => {
  const result = await loadRequest({
    getBullpenAutoLiveDashboardSummary: async () => { throw new Error('Summary delayed'); },
    get: async () => { throw new Error('State delayed'); },
  })(new AbortController().signal);
  assert.equal(result.summary, null);
  assert.equal(result.hasSettings, false);
  assert.deepEqual(result.issues, ['Summary: Summary delayed', 'State: State delayed']);
});

test('cancellation does not trigger fallback requests or convert cancellation into an error panel', async () => {
  const controller = new AbortController();
  const read = loadRequest({
    getBullpenAutoLiveDashboardSummary: async () => { controller.abort(); throw new Error('Aborted transport'); },
    get: () => assert.fail('Cancelled display must not start a fallback'),
  });
  await assert.rejects(read(controller.signal), { name: 'AbortError' });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function reloadHarness(requestDashboard) {
  const written = { summaries: [], errors: [], loading: [], refreshing: [], settings: [] };
  const dashboardRequestRef = { current: null };
  const reload = loadFunction('reloadDashboard', {
    dashboardRequestRef, requestDashboard,
    normalizeError: (error) => error.message,
    setSummary: (value) => written.summaries.push(value),
    setError: (value) => written.errors.push(value),
    setLoading: (value) => written.loading.push(value),
    setRefreshing: (value) => written.refreshing.push(value),
    setSettingsAvailable: (value) => written.settings.push(value),
  });
  return { reload, written, dashboardRequestRef };
}

test('a newer refresh cancels the previous read and prevents late results from replacing it', async () => {
  const requests = [];
  const harness = reloadHarness((signal) => { const item = deferred(); requests.push({ ...item, signal }); return item.promise; });
  const first = harness.reload();
  const second = harness.reload();
  assert.equal(requests[0].signal.aborted, true);
  const newest = snapshot();
  requests[1].resolve({ summary: newest, hasSettings: true, issues: [] });
  await second;
  requests[0].resolve({ summary: { ...snapshot(), latest_run: { id: 'old-run' } }, hasSettings: false, issues: ['Old failure'] });
  await first;
  assert.deepEqual(harness.written.summaries, [newest]);
  assert.deepEqual(harness.written.errors, [null]);
  assert.deepEqual(harness.written.settings, [true]);
  assert.deepEqual(harness.written.loading, [false]);
});

test('unmounted refreshes cannot write state and failed refreshes retain the last successful summary', async () => {
  const pending = deferred();
  const harness = reloadHarness(() => pending.promise);
  const read = harness.reload();
  harness.dashboardRequestRef.current.abort();
  harness.dashboardRequestRef.current = null;
  pending.resolve({ summary: snapshot(), hasSettings: true, issues: [] });
  await read;
  assert.deepEqual(harness.written.summaries, []);
  assert.deepEqual(harness.written.errors, []);
  const failure = reloadHarness(async () => ({ summary: null, hasSettings: false, issues: ['Summary delayed', 'State delayed'] }));
  await failure.reload();
  assert.deepEqual(failure.written.summaries, []);
  assert.deepEqual(failure.written.errors, ['Summary delayed • State delayed']);
  assert.match(source, /dashboardRequestRef\.current\?\.abort\(\);\s*dashboardRequestRef\.current = null/);
});

test('guardrail saves and exports contain only editor-owned fields, preserving omitted private settings', () => {
  const loaded = { exports: {} };
  new Function('exports', 'module', compile(read(`${base}bullpenAiAutoLiveRiskGuardrails.ts`)))(loaded.exports, loaded);
  const {
    BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
    BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS,
    bullpenAiAutoLiveSettingsToDraft,
    validateBullpenAiAutoLiveGuardrailDraft,
    buildBullpenAiAutoLiveGuardrailUpdate,
    serializeBullpenAiAutoLiveGuardrails,
  } = loaded.exports;
  const saved = { ...BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS, console_llm_prompt_template: 'Saved custom prompt', console_llm_targets: [{ provider: 'saved-provider', model: 'saved-model' }], strategy_profile: 'bullpen_console_top10', console_scan_scope: 'all' };
  const projected = { ...saved, console_llm_prompt_template: null };
  const draft = bullpenAiAutoLiveSettingsToDraft(projected);
  draft.bankroll_usd = '250';
  const { settings } = validateBullpenAiAutoLiveGuardrailDraft(draft);
  assert.ok(settings);
  const update = buildBullpenAiAutoLiveGuardrailUpdate(settings);
  assert.deepEqual(Object.keys(update).sort(), BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS.map((field) => field.key).sort());
  assert.equal(update.bankroll_usd, 250);
  const merged = { ...saved, ...update };
  for (const hidden of ['console_llm_prompt_template', 'console_llm_targets', 'console_scan_scope', 'strategy_profile']) {
    assert.equal(Object.hasOwn(update, hidden), false);
    assert.deepEqual(merged[hidden], saved[hidden]);
  }
  assert.deepEqual(JSON.parse(serializeBullpenAiAutoLiveGuardrails(settings)), update);
  assert.match(read(`${base}BullpenAiAutoLiveRiskGuardrailsDrawer.tsx`), /updateBullpenAutoLiveSettings\(buildBullpenAiAutoLiveGuardrailUpdate\(validation\.settings\)\)/);
});

test('display retains saved-run navigation and guarded explicit-action handlers', () => {
  assert.match(source, /href=\{URLs\.routes\.console\.runs\(\)\}/);
  assert.match(source, /hasSettings: false/);
  assert.match(source, /settings=\{settingsAvailable \? summary\.settings : null\}/);
  assert.match(findFunction('handleAction'), /runBullpenAutoLiveOnce/);
  assert.match(findFunction('handleAction'), /startBullpenAutoLive/);
  assert.match(findFunction('handleAction'), /pauseBullpenAutoLive/);
  assert.match(findFunction('handleAction'), /stopBullpenAutoLive/);
});
