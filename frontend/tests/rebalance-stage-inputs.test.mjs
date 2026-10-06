import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import * as jsxRuntime from 'react/jsx-runtime';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const modules = {};
modules['react/jsx-runtime'] = jsxRuntime;
function load(source, bindings = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  new Function('exports', 'require', ...Object.keys(bindings), compiled)(
    exports, (name) => {
      assert.ok(modules[name], `Unexpected runtime import: ${name}`);
      return modules[name];
    }, ...Object.values(bindings),
  );
  return exports;
}
modules['@/lib/rebalanceRunIdentity'] = load(read('../lib/rebalanceRunIdentity.ts'));
modules['@/lib/rebalanceStageInputs'] = load(read('../lib/rebalanceStageInputs.ts'));
modules['@/lib/autoRebalanceAudit'] = load(read('../lib/autoRebalanceAudit.ts'));
modules['@/lib/outputSourceJobs'] = load(read('../lib/outputSourceJobs.ts'), { crypto: webcrypto });
const inputs = modules['@/lib/rebalanceStageInputs'];
const rebalance = load(read('../lib/rebalance.ts'));
const portfolioSnapshot = { parse_status: 'parsed', reported_holdings_count: 1,
  holdings: [{ symbol: 'ABC', quantity: 0.125 }] };
const swing = load(read('../lib/swingTrade.ts'));
const scope = { market: 'us', stage: 'swing' };
const timestamp = '2026-10-02T20:30:00Z';

function run(id = 50, jobIds = [501, 502], stage = 'swing', market = 'us') {
  const prompt = stage === 'rebalance' ? `[REBALANCE_FLOW:${market}]\nRebalance portfolio.`
    : `Act as a top-tier ${market === 'us' ? 'US' : 'India'} aggressive swing-trading strategist.`;
  const metadata = {
    auto_rebalance_portfolio: market === 'us' ? 'indmoney_us' : 'india',
    auto_rebalance_sequence: id,
    auto_rebalance_label: `${market === 'us' ? 'IndMoney US' : 'India'} Run #${id} (${stage === 'swing' ? 'Swing' : 'Rebalance'} Scan)`,
  };
  return {
    id, prompt, ...metadata, status: 'completed', created_at: timestamp, updated_at: timestamp,
    synthesis_response: null, decision_response: null, export_sheet_name: 'saved scan',
    run_jobs: jobIds.map((jobId) => ({
      id: jobId + 1000, run_id: id, job_id: jobId, stage: 1,
      job: { id: jobId, prompt, ...metadata, status: 'completed', provider: 'openai', model: 'same-model',
        response: `| NASDAQ | STOCK${jobId} | +3 | Bullish rationale ${jobId} |\n| NASDAQ | STOCK${jobId} | -3 | Bearish dissent ${jobId} |`,
        created_at: timestamp, updated_at: timestamp,
      },
    })),
  };
}
function threat(jobId = 99, origin = 'selected', market = 'us') {
  return {
    identity: { kind: 'threat-job', stage: 'threats', market, jobId }, origin,
    analysis: { job_id: jobId, status: 'completed', provider: 'openai', model: 'same-model',
      created_at: timestamp, updated_at: timestamp, snapshot_date: '2026-10-02', captured_at: timestamp,
      report: { raw_markdown: 'Keep the current risk and the dissenting view.' },
    },
  };
}
const keys = (runs) => runs.flatMap((item) => item.run_jobs.map((link) => `${item.id}:${link.job_id}`));
const refreshError = /Refresh Select Inputs and start a new workflow/;

test('generated/selected duplicates disappear once, while same-model jobs retain exact evidence and order', () => {
  const generated = run();
  const selected = { ...structuredClone(generated), run_jobs: [structuredClone(generated.run_jobs[1])] };
  const independent = run(51, [503, 504]);
  independent.run_jobs[0].job.response = generated.run_jobs[0].job.response;
  const before = structuredClone([generated, selected, independent]);
  const actual = inputs.deduplicateStageRunInputs([generated, selected, independent, generated], scope);
  assert.deepEqual(keys(actual), ['50:501', '50:502', '51:503', '51:504']);
  assert.deepEqual(actual.flatMap((r) => r.run_jobs.map((j) => j.job.response)),
    [generated, independent].flatMap((r) => r.run_jobs.map((j) => j.job.response)));
  assert.deepEqual([generated, selected, independent], before, 'source objects are not mutated');
  assert.deepEqual(keys(inputs.deduplicateStageRunInputs([generated], scope)), ['50:501', '50:502'], 'each workflow gets independent local identity state');
});

test('duplicate representations reject changed output/provenance and preserve compatible export updates', () => {
  const original = run();
  const mutations = [
    (copy) => { copy.run_jobs[0].job.response += '\nNew dissent'; },
    (copy) => { copy.run_jobs[0].job.provider = 'another-provider'; },
    (copy) => { copy.run_jobs[0].job.status = 'partial'; },
    (copy) => { copy.prompt += '\nDifferent context'; },
    (copy) => { copy.auto_rebalance_sequence += 1; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(original);
    mutate(copy);
    assert.throws(() => inputs.deduplicateStageRunInputs([original, copy], scope), refreshError);
  }
  const exported = structuredClone(original);
  exported.updated_at = '2026-10-02T21:00:00Z';
  exported.run_jobs[0].job.updated_at = exported.updated_at;
  exported.export_status = 'completed';
  assert.deepEqual(keys(inputs.deduplicateStageRunInputs([original, exported], scope)), ['50:501', '50:502']);
});

test('cross-market/stage, contradictory child identity and malformed run links fail closed', () => {
  const invalid = [run(50, [501], 'swing', 'india'), run(50, [501], 'rebalance'), run(50, [])];
  for (const mutate of [
    (copy) => { copy.run_jobs[0].job.auto_rebalance_portfolio = 'india'; },
    (copy) => { copy.run_jobs[0].run_id = 900; },
    (copy) => { copy.run_jobs[0].job_id = 900; },
    (copy) => { copy.run_jobs[0].job.status = 'processing'; },
  ]) {
    const copy = run(); mutate(copy); invalid.push(copy);
  }
  for (const source of invalid) assert.throws(() => inputs.deduplicateStageRunInputs([source], scope), refreshError);
});

test('run selection keeps exact historical jobs and rejects missing, malformed or wrong-stage selections', () => {
  const historical = run(2, [21, 22]);
  historical.created_at = '2020-01-01T00:00:00Z';
  const selection = new Set(['rebalance:next', 'run:2:job:22', 'run:50:job:501']);
  assert.deepEqual(inputs.getSelectedStageRunIds(selection, 'swing'), [2, 50]);
  assert.deepEqual(keys(inputs.selectStageRunInputs([historical, run()], selection, scope)), ['2:22', '50:501']);
  for (const selected of [new Set(['run:2:job:99']), new Set(['run:0:job:21']), new Set(['technical:next'])]) {
    assert.throws(() => inputs.selectStageRunInputs([historical], selected, scope), refreshError);
  }
  assert.throws(() => inputs.selectStageRunInputs([run(2, [21], 'rebalance')], new Set(['run:2:job:21']), scope), refreshError);
});

test('threat identity removes repeated delivery but retains distinct job IDs even with identical content', () => {
  const generated = threat(99, 'generated');
  const selected = threat(99);
  const historical = threat(98);
  assert.deepEqual(inputs.deduplicateThreatStageInputs([generated, selected, historical], 'us'), [generated, historical]);
  assert.deepEqual(inputs.getSelectedThreatJobIds(new Set(['swing:next', 'threat:99', 'threat:98'])), [99, 98]);
  for (const mutate of [
    (copy) => { copy.analysis.report.raw_markdown += '\nChanged risk'; },
    (copy) => { copy.identity.market = 'india'; },
    (copy) => { copy.identity.stage = 'swing'; },
    (copy) => { copy.analysis.job_id = 98; },
    (copy) => { copy.analysis.status = 'processing'; },
  ]) {
    const copy = structuredClone(selected); mutate(copy);
    assert.throws(() => inputs.deduplicateThreatStageInputs([generated, copy], 'us'), refreshError);
  }
});

test('the final swing bundle deduplicates sources while preserving signed, repeated and dissenting rows', () => {
  const generated = run();
  generated.run_jobs[0].job.response = '| STOCK | +3 | Same rationale |\n| STOCK | -3 | Same rationale |\n| STOCK | -3 | Same rationale |';
  const result = rebalance.buildRebalanceInputBundle({ market: 'us', portfolio: {
    parse_status: 'parsed', holdings: [{ symbol: 'ABC', quantity: 0.125 }],
  }, threats: null,
    previousClose: new Date('2026-10-02T20:00:00Z'), swingRuns: [generated, structuredClone(generated)],
  });
  assert.equal(result.match(/## Swing Trade Run #50/g)?.length, 1);
  assert.equal(result.match(/\| STOCK \| \+3 \|/g)?.length, 1);
  assert.equal(result.match(/\| STOCK \| -3 \|/g)?.length, 2);
  assert.match(result, /Bearish dissent 502/);
});

test('INDmoney rejects Explore, missing, incomplete and ambiguous holdings before rebalance', () => {
  const valid = { parse_status: 'parsed', reported_holdings_count: 1,
    holdings: [{ symbol: 'ABC', quantity: 0.125 }] };
  for (const snapshot of [null, { parse_status: 'unparsed', holdings: [] },
    { ...valid, reported_holdings_count: 2 },
    { ...valid, holdings: [{ symbol: 'ABC', quantity: null }] },
    { ...valid, reported_holdings_count: 2, holdings: [...valid.holdings, ...valid.holdings] }]) {
    assert.throws(() => rebalance.buildRebalanceInputBundle({ market: 'us', portfolio: snapshot,
      threats: null, previousClose: new Date(), swingRuns: [] }), /My US Stocks/);
  }
  assert.doesNotThrow(() => rebalance.assertIndmoneyHoldingsSnapshot(valid));
  assert.doesNotThrow(() => rebalance.assertIndmoneyHoldingsSnapshot({ ...valid, parse_status: 'partial' }));
  assert.doesNotThrow(() => rebalance.buildRebalanceInputBundle({ market: 'india', portfolio: null,
    threats: null, previousClose: new Date(), swingRuns: [] }));
});

const workflowSource = read('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx');
const ast = ts.createSourceFile('workflow.tsx', workflowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (node.name && ['runWorkflow', 'STAGE_ORDER', 'buildRunPayload', 'RecordedWorkflowStageFailure'].includes(node.name.getText(ast))) {
    declarations.set(node.name.getText(ast), node);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const callbackSource = declarations.get('runWorkflow').initializer.arguments[0].getText(ast);
const helpers = load(`${declarations.get('buildRunPayload').getText(ast)}\n${declarations.get('RecordedWorkflowStageFailure').getText(ast)}\nexport const STAGE_ORDER = ${declarations.get('STAGE_ORDER').initializer.getText(ast)};\nexport { buildRunPayload, RecordedWorkflowStageFailure };`);

async function executeWorkflow({ stages = ['sync', 'threats', 'swing', 'rebalance', 'technical', 'actionables'], selected = {}, runOverrides = {}, threatOverrides = {}, snapshot = portfolioSnapshot,
  sourceHasher = modules['@/lib/outputSourceJobs'].buildOutputSourceJobs, cancelRequestedRef = { current: false } } = {}) {
  const created = [];
  const completed = [];
  const errors = [];
  const threatReads = [];
  const runReads = [];
  const consensusInputs = [];
  const generatedSwing = run();
  const generatedRebalance = run(60, [601, 602], 'rebalance');
  const selectedInputs = { indmoneyUs: {
    swing: new Set(['swing:next', 'threat:99', 'threat:98']),
    rebalance: new Set(['rebalance:next', 'run:50:job:501', 'run:51:job:503']),
    technical: new Set(['technical:next', 'run:60:job:601', 'run:61:job:603']),
    actionables: new Set(['actionables:next']), ...selected,
  } };
  const saved = new Map([[50, generatedSwing], [51, run(51, [503])], [60, generatedRebalance], [61, run(61, [603], 'rebalance')]]);
  const targets = [{ provider: 'openai', model: 'same-model' }, { provider: 'openai', model: 'same-model' }];
  const noop = () => {};
  const apiService = {
    getProviders: async () => [],
    indmoneyUsPortfolioOverview: async () => ({ latest: snapshot }),
    indmoneyUsRunThreats: async () => { created.push({ stage: 'threats', targets: [targets[0]] }); return { job_id: 99 }; },
    indmoneyUsThreatJob: async (id) => { threatReads.push(id); return threatOverrides[id] ?? threat(id).analysis; },
    indmoneyUsThreatsLatest: async () => ({ analysis: threat(99).analysis }),
    getRuns: async () => ({ items: [generatedSwing] }),
    getRun: async (id) => { runReads.push(id); return structuredClone(runOverrides[id] ?? saved.get(id)); },
    createRun: async (payload) => {
      const stage = payload.auto_rebalance_label.includes('(Swing Scan)') ? 'swing'
        : payload.auto_rebalance_label.includes('(Rebalance Scan)') ? 'rebalance' : 'technical';
      created.push({ stage, ...payload });
      return stage === 'swing' ? generatedSwing : stage === 'rebalance' ? generatedRebalance : { id: 70 };
    },
    queueAutoRebalanceCompletionEmail: async () => {},
  };
  const bindings = {
    ...inputs, ...rebalance, ...swing, ...helpers, ...modules['@/lib/rebalanceRunIdentity'],
    ...modules['@/lib/autoRebalanceAudit'], ...modules['@/lib/outputSourceJobs'], buildOutputSourceJobs: sourceHasher, apiService,
    specificMode: { indmoneyUs: true }, selectedStages: { indmoneyUs: new Set(stages) }, selectedInputs,
    isWorkflowExecutingRef: { current: false }, activeExecutionRefsRef: { current: [] },
    activeAutoRebalanceMetadataRef: { current: {} }, cancelRequestedRef, pauseRequestedRef: { current: false },
    auditSessionsRef: { current: {} }, setAuditStates: noop, setCompletionEmailWarnings: noop,
    // Persistence behavior is exercised by auto-rebalance-audit-persistence;
    // this harness isolates the existing source-selection/model-call contract.
    getAuditSession: () => ({ key: 'indmoney_us:100', verifyCompletion: async () => true, drain: async () => {} }),
    setRunningPortfolio: noop, resetPortfolio: noop, setWorkflowPaused: noop, setActiveAutoRebalanceMetadata: noop, setStates: noop,
    updateStage: (_portfolio, stage, info) => { if (info.error) errors.push({ stage, error: info.error }); },
    markRunning: noop, markCompleted: (_portfolio, stage) => { completed.push(stage); },
    completeSkippedStage: noop, onDashboardRefresh: async () => {}, recordAutoRebalanceStage: async () => {},
    reserveAutoRebalanceRunMetadata: async () => ({ auto_rebalance_portfolio: 'indmoney_us', auto_rebalance_sequence: 100, auto_rebalance_label: 'IndMoney US Run #100' }),
    retryWorkflowRead: async (read) => read(), getSavedStageTargets: () => targets,
    waitForThreatCompletion: async () => threat(99, 'generated').analysis,
    waitForRunWithStageHandling: async (_portfolio, stage) => stage === 'swing' ? generatedSwing : stage === 'rebalance' ? generatedRebalance : { id: 70 },
    summarizeThreat: () => ({}), summarizeRun: () => ({}), getRunProgress: () => ({}), countUniqueStocksFromRun: () => 2,
    parseTimestampMs: (date) => Date.parse(date), getPreviousMarketClose: () => new Date('2026-10-02T20:00:00Z'),
    getLatestMatchingRebalanceRuns: (runs) => runs.filter((r) => modules['@/lib/rebalanceRunIdentity'].isAnalysisRunForStage(r, 'rebalance', 'us')),
    fetchAllFullRuns: async () => [generatedRebalance],
    buildConsensusRows: (runs) => { consensusInputs.push(runs); return runs.map((r) => ({ id: r.id, jobs: r.run_jobs.map((link) => link.job.response) })); },
    buildTechnicalScanPrompt: (rows) => JSON.stringify(rows), getStageTileLabel: (stage) => stage,
    window: { setTimeout: noop, dispatchEvent: noop }, CustomEvent: class {},
    WORKFLOW_COMPLETION_RESET_DELAY_MS: 0, normalizeError: (error) => error.message,
  };
  const { execute } = load(`export const execute = ${callbackSource};`, bindings);
  await execute('indmoneyUs');
  return { created, completed, errors, threatReads, runReads, consensusInputs, targets };
}

test('invalid saved INDmoney snapshot fails sync before any paid stage is queued', async () => {
  const result = await executeWorkflow({ snapshot: { parse_status: 'unparsed', holdings: [] } });
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.completed, []);
  assert.equal(result.errors[0].stage, 'sync');
  assert.match(result.errors[0].error, /My US Stocks/);
});

test('offline full workflow keeps six stages and independent model samples while emitting each selected source once', async () => {
  const result = await executeWorkflow();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.completed, ['sync', 'threats', 'swing', 'rebalance', 'technical', 'actionables']);
  assert.deepEqual(result.created.map((call) => [call.stage, call.targets.length]), [['threats', 1], ['swing', 2], ['rebalance', 2], ['technical', 1]]);
  const swingPrompt = result.created.find((call) => call.stage === 'swing').prompt;
  assert.equal(swingPrompt.match(/Threat Scan #99/g)?.length, 1);
  assert.equal(swingPrompt.match(/Threat Scan #98/g)?.length, 1);
  assert.deepEqual(result.threatReads, [99, 98], 'selected historical threats are fetched by their own ID');
  const rebalancePrompt = result.created.find((call) => call.stage === 'rebalance').prompt;
  for (const jobId of [501, 502, 503]) assert.equal(rebalancePrompt.match(new RegExp(`Bullish rationale ${jobId}`, 'g'))?.length, 1);
  assert.deepEqual(keys(result.consensusInputs[1]), ['60:601', '60:602', '61:603']);
  assert.deepEqual(result.created.find((call) => call.stage === 'swing').targets, result.targets);
});

test('Kill during deferred source hashing prevents the next paid Rebalance call', { timeout: 5000 }, async () => {
  const cancelRequestedRef = { current: false };
  let releaseHashing;
  let signalHashing;
  const held = new Promise((resolve) => { releaseHashing = resolve; });
  const hashingStarted = new Promise((resolve) => { signalHashing = resolve; });
  const pending = executeWorkflow({ cancelRequestedRef, sourceHasher: async (...args) => {
    const sources = await modules['@/lib/outputSourceJobs'].buildOutputSourceJobs(...args);
    signalHashing();
    await held;
    return sources;
  } });
  await hashingStarted;
  cancelRequestedRef.current = true;
  releaseHashing();
  const result = await pending;
  assert.deepEqual(result.created.map((call) => call.stage), ['threats', 'swing']);
  assert.ok(!result.completed.includes('rebalance'));
  assert.ok(!result.completed.includes('technical'));
  assert.ok(result.errors.some((entry) => entry.stage === 'rebalance' && /killed by user/.test(entry.error)));
});

test('offline workflow rejects stale/conflicting and out-of-scope sources before the next paid stage', async () => {
  const conflict = run(); conflict.run_jobs[0].job.response += '\nConflicting version';
  const conflictingThreat = threat(99).analysis;
  conflictingThreat.report.raw_markdown += '\nConflicting version';
  const conflictingRebalance = run(60, [601, 602], 'rebalance');
  conflictingRebalance.run_jobs[0].job.response += '\nConflicting version';
  const cases = [
    { runOverrides: { 50: conflict }, expectedStages: ['threats', 'swing'], failed: 'rebalance' },
    { runOverrides: { 60: conflictingRebalance }, expectedStages: ['threats', 'swing', 'rebalance'], failed: 'technical' },
    { threatOverrides: { 99: conflictingThreat }, expectedStages: ['threats'], failed: 'swing' },
    { stages: ['rebalance'], runOverrides: { 50: run(50, [501], 'swing', 'india') }, expectedStages: [], failed: 'rebalance' },
    { stages: ['technical'], runOverrides: { 60: run(60, [601], 'swing') }, expectedStages: [], failed: 'technical' },
    { stages: ['swing'], threatOverrides: { 99: { ...threat(99).analysis, job_id: 777 } }, expectedStages: [], failed: 'swing' },
    { stages: ['rebalance'], selected: { rebalance: new Set(['run:50:job:999']) }, expectedStages: [], failed: 'rebalance' },
  ];
  for (const { expectedStages, failed, ...options } of cases) {
    const result = await executeWorkflow(options);
    assert.deepEqual(result.created.map((call) => call.stage), expectedStages);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, failed);
    assert.match(result.errors[0].error, refreshError);
  }
});

test('offline latest fallback deduplicates generated runs without changing selected stages or model samples', async () => {
  const result = await executeWorkflow({ selected: {
    rebalance: new Set(['rebalance:next']), technical: new Set(['technical:next']),
  } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.created.map((call) => [call.stage, call.targets.length]), [['threats', 1], ['swing', 2], ['rebalance', 2], ['technical', 1]]);
  assert.deepEqual(keys(result.consensusInputs[1]), ['60:601', '60:602']);
  const prompt = result.created.find((call) => call.stage === 'rebalance').prompt;
  for (const jobId of [501, 502]) assert.equal(prompt.match(new RegExp(`Bullish rationale ${jobId}`, 'g'))?.length, 1);
});

test('manual rebalance shows actionable validation errors and blocks submit without breaking valid controls', () => {
  const manualSource = read('../app/console/_components/PortfolioRebalanceConsole.tsx');
  const manualAst = ts.createSourceFile('manual.tsx', manualSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const extracted = manualAst.statements.filter((node) => ['normalizeError', 'buildRebalanceInputPreviews'].includes(node.name?.getText(manualAst))).map((node) => node.getText(manualAst)).join('\n');
  const { buildRebalanceInputPreviews } = load(`${extracted}\nexport { buildRebalanceInputPreviews };`, rebalance);
  const valid = { market: 'us', portfolio: portfolioSnapshot, threats: null, previousClose: new Date('2026-10-02T20:00:00Z'), swingRuns: [run()] };
  const previews = buildRebalanceInputPreviews(valid);
  assert.equal(previews.error, null);
  assert.match(previews.prompt, /Bullish rationale 501/);
  assert.match(previews.display, /same-model/);
  const invalidPreviews = buildRebalanceInputPreviews({ ...valid, swingRuns: [run(50, [501], 'swing', 'india')] });
  assert.match(invalidPreviews.error, refreshError);
  assert.equal(invalidPreviews.prompt, '');
  assert.match(manualSource, /submitBlockedReason=\{inputError\}/);
  assert.match(manualSource, /if \(inputError\) return;/);

  const cardSource = read('../app/console/dashboard/_components/CreateJobCard.tsx');
  const cardAst = ts.createSourceFile('card.tsx', cardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const cardFunction = cardAst.statements.find((node) => node.name?.getText(cardAst) === 'CreateJobCard').getText(cardAst);
  let submissions = 0;
  const { CreateJobCard } = load(cardFunction, {
    useDashboard: () => ({ prompt: 'Valid user prompt', scheduledAt: null, submitting: false, submitError: null,
      selectedTargets: new Set(['same-model-1', 'same-model-2']), handleSubmit: () => { submissions += 1; },
    }),
    useState: () => [true, () => {}], cn: (...items) => items.filter(Boolean).join(' '),
    Card: 'section', CardHeader: 'header', CardContent: 'main', CardTitle: 'h2', Button: 'button',
    RunModeFields: 'div', TemplateField: 'div', PromptField: 'div', ScheduleField: 'div',
    Send: 'span', Loader2: 'span', CalendarClock: 'span', ChevronUp: 'span', ChevronDown: 'span',
  });
  function findElement(element, predicate) {
    if (!element || typeof element !== 'object') return null;
    if (predicate(element)) return element;
    const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children];
    return children.map((child) => findElement(child, predicate)).find(Boolean);
  }
  for (const reason of [invalidPreviews.error, null]) {
    const tree = CreateJobCard({ submitBlockedReason: reason });
    const button = findElement(tree, (node) => node.type === 'button' && node.props.type === 'submit');
    assert.equal(button.props.disabled, Boolean(reason));
    const form = findElement(tree, (node) => node.type === 'form');
    let prevented = false;
    form.props.onSubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, Boolean(reason), 'keyboard/programmatic submission follows the same guard');
    if (reason) assert.equal(findElement(tree, (node) => node.props?.role === 'alert').props.children, reason);
  }
  assert.equal(submissions, 1, 'only the valid form invokes the original submit handler');
});
