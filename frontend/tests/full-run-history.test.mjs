import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function loadPureModule(path) {
  const loadedModule = { exports: {} };
  new Function('exports', 'module', compile(read(path)))(loadedModule.exports, loadedModule);
  return loadedModule.exports;
}

const { loadFullRunHistory } = loadPureModule('../lib/fullRunHistory.ts');
const { PrivateRequestDeduplicator } = loadPureModule('../lib/privateRequestDeduplicator.ts');

function loadHistoryService(api) {
  const source = ts.createSourceFile('api.ts', read('../services/api.ts'), ts.ScriptTarget.Latest, true);
  const service = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'apiServiceClass');
  const names = new Set(['readDeduplicator', 'setSessionGeneration', 'getAllFullRuns']);
  const members = service.members.filter((node) => names.has(node.name?.getText(source)));
  assert.equal(members.length, 3);
  const loadedModule = { exports: {} };
  new Function('exports', 'module', 'PrivateRequestDeduplicator', 'loadFullRunHistory', 'URLs', compile(`
    export class HistoryService { ${members.map((node) => node.getText(source)).join('\n')} }
  `))(loadedModule.exports, loadedModule, PrivateRequestDeduplicator, loadFullRunHistory, { runs: { list: () => '/runs' } });
  return Object.assign(new loadedModule.exports.HistoryService(), api);
}

function pages(ids, size) {
  return async ({ page, limit, summary }) => {
    assert.equal(summary, true);
    assert.equal(limit, 100);
    return { items: ids.slice((page - 1) * size, page * size).map((id) => ({ id })), pages: Math.ceil(ids.length / size) };
  };
}

test('history reads summaries and bounded individual details without dropping old or large inputs', async () => {
  const ids = Array.from({ length: 338 }, (_, index) => 338 - index);
  const details = [];
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const api = {
    getRuns: async (params) => { calls.push(params.page); return pages(ids, 100)(params); },
    getFullRuns: () => { throw new Error('Full run lists exceed the response budget'); },
    getRun: async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      details.push(id);
      return { id, prompt: `Historical input ${id}`, run_jobs: id === 1 ? [{ job: { response: 'x'.repeat(1_000_001) } }] : [] };
    },
  };
  const result = await loadFullRunHistory(api);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.deepEqual(result.map((run) => run.id), ids);
  assert.deepEqual(details, ids);
  assert.equal(maxActive, 4);
  assert.equal(result.at(-1).run_jobs[0].job.response.length, 1_000_001);
});

test('overlapping summary pages hydrate each run only once', async () => {
  const api = { getRuns: pages([5, 4, 4, 3, 2, 1], 2), getRun: async (id) => ({ id }) };
  assert.deepEqual((await loadFullRunHistory(api)).map((run) => run.id), [5, 4, 3, 2, 1]);
});

test('detail failures reject the full history rather than turning partial inputs into counts', async () => {
  const failure = new Error('Selected run could not be loaded');
  const calls = [];
  const api = {
    getRuns: pages([9, 8, 7, 6, 5], 100),
    getRun: async (id) => { calls.push(id); if (id === 8) throw failure; return { id }; },
  };
  await assert.rejects(loadFullRunHistory(api), (error) => error === failure);
  assert.deepEqual(calls, [9, 8, 7, 6]);
});

test('simultaneous consumers share one history read and refresh after settlement', async () => {
  let summaryCalls = 0;
  let detailCalls = 0;
  const service = loadHistoryService({
    getRuns: async (params) => { summaryCalls += 1; return pages([3, 2, 1], 100)(params); },
    getRun: async (id) => { detailCalls += 1; return { id }; },
  });
  service.setSessionGeneration('user-1:session-a');
  const first = service.getAllFullRuns();
  const second = service.getAllFullRuns();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(summaryCalls, 1);
  assert.equal(detailCalls, 3);
  await service.getAllFullRuns();
  assert.equal(summaryCalls, 2);
  assert.equal(detailCalls, 6);
});

test('failed in-flight histories retire so retry can recover', async () => {
  let shouldFail = true;
  const service = loadHistoryService({
    getRuns: pages([1], 100),
    getRun: async (id) => { if (shouldFail) throw new Error('Temporary read failure'); return { id }; },
  });
  await assert.rejects(service.getAllFullRuns(), /Temporary read failure/);
  shouldFail = false;
  assert.deepEqual(await service.getAllFullRuns(), [{ id: 1 }]);
});

test('a session change stops the old multi-request history and never shares it with the new user', async () => {
  let release;
  let detailCalls = 0;
  const service = loadHistoryService({
    getRuns: () => new Promise((resolve) => { release = () => resolve({ items: [{ id: 1 }], pages: 1 }); }),
    getRun: async (id) => { detailCalls += 1; return { id }; },
  });
  service.setSessionGeneration('user-1:session-a');
  const oldRead = service.getAllFullRuns();
  service.setSessionGeneration('user-2:session-b');
  release();
  await assert.rejects(oldRead, /session changed/);
  assert.equal(detailCalls, 0);
  service.getRuns = pages([2], 100);
  assert.deepEqual(await service.getAllFullRuns(), [{ id: 2 }]);
});

test('empty successful history stays empty without requesting details', async () => {
  const result = await loadFullRunHistory({ getRuns: pages([], 100), getRun: () => assert.fail('No details expected') });
  assert.deepEqual(result, []);
});

function loadSetupNameCell() {
  const source = ts.createSourceFile('page.tsx', read('../app/console/technical-setups/page.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['SETUP_ACTION_COUNT_ORDER', 'getSetupActionCounts', 'SetupActionCountBreakdown', 'SetupNameCell']);
  const selected = source.statements.filter((node) => names.has(node.name?.getText(source)) || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.has(item.name.getText(source)))));
  const loadedModule = { exports: {} };
  new Function('exports', 'module', 'require', compile(`${selected.map((node) => node.getText(source)).join('\n')}\nexport { SetupNameCell };`))(loadedModule.exports, loadedModule, require);
  return loadedModule.exports.SetupNameCell;
}

test('Scanner differentiates loading and unavailable counts from a verified zero', () => {
  const SetupNameCell = loadSetupNameCell();
  const render = (countsStatus, group) => renderToStaticMarkup(createElement(SetupNameCell, { row: { setup: 'Breakout' }, countsStatus, group, onSetupClick: () => {} }));
  assert.match(render('loading'), /Breakout \(Loading…\)/);
  assert.match(render('error'), /Breakout \(Unavailable\)/);
  assert.doesNotMatch(render('loading'), /\(0\)/);
  assert.doesNotMatch(render('error'), /\(0\)/);
  assert.match(render('ready'), /Breakout \(0\)/);
  assert.match(render('ready', { stocks: [{ action: 'Buy New' }] }), /Total stocks: 1/);
  assert.doesNotMatch(render('error', { stocks: [{ action: 'Buy New' }] }), /Total stocks/);
});

test('all full-history consumers delegate to the summary-first service and Scanner exposes retry', () => {
  const actionables = read('../app/console/_components/FinalActionablesConsole.tsx');
  assert.match(actionables, /export async function fetchAllFullRuns\(\) \{\s*return apiService\.getAllFullRuns\(\);\s*\}/);
  const scanner = read('../app/console/technical-setups/page.tsx');
  assert.match(scanner, /role="alert"/);
  assert.match(scanner, /Retry counts/);
  assert.match(scanner, /setLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(scanner, /\}, \[loadAttempt\]\)/);
  assert.match(scanner, /if \(!ignore\) \{\s*setCountsStatus\('error'\)/);
});

function authSessionRegistration(service, session, user) {
  const source = ts.createSourceFile('AuthProvider.tsx', read('../providers/AuthProvider.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let registration;
  function visit(node) {
    if (ts.isCallExpression(node) && /^use(?:Layout)?Effect$/.test(node.expression.getText(source)) && node.arguments[0]?.getText(source).includes('apiService.setSessionGeneration(')) registration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(registration);
  const register = new Function('apiService', 'session', 'user', `return (${registration.arguments[0].getText(source)});`)(service, session, user);
  return { phase: registration.expression.getText(source), register };
}

test('server-authenticated identity registers before descendant passive history effects', async () => {
  const service = loadHistoryService({ getRuns: pages([71], 100), getRun: async (id) => ({ id }) });
  const registration = authSessionRegistration(service, { generation: 'fixture-session-71' }, { id: 71 });
  const errors = [];
  let request;
  // React commits layout effects before passive effects; passive effects visit
  // children before parents. Execute both branches so reverting to useEffect
  // reproduces the signed-in initial-load failure rather than only a regex fail.
  if (registration.phase === 'useLayoutEffect') registration.register();
  request = service.getAllFullRuns().catch((error) => { errors.push(error); return []; });
  if (registration.phase === 'useEffect') registration.register();
  assert.deepEqual(await request, [{ id: 71 }]);
  assert.deepEqual(errors, []);
});

test('StrictMode registration replay and same-session refresh do not cancel active history', async () => {
  let release;
  const service = loadHistoryService({
    getRuns: () => new Promise((resolve) => { release = () => resolve({ items: [{ id: 71 }], pages: 1 }); }),
    getRun: async (id) => ({ id }),
  });
  const registration = authSessionRegistration(service, { generation: 'fixture-session-71' }, { id: 71 });
  registration.register();
  const request = service.getAllFullRuns();
  registration.register();
  authSessionRegistration(service, { generation: 'fixture-session-71', expires: 'later' }, { id: 71 }).register();
  assert.equal(service.getAllFullRuns(), request);
  release();
  assert.deepEqual(await request, [{ id: 71 }]);
});

test('real account switch through AuthProvider still invalidates the old history flight', async () => {
  let release;
  const service = loadHistoryService({
    getRuns: () => new Promise((resolve) => { release = () => resolve({ items: [{ id: 71 }], pages: 1 }); }),
    getRun: () => assert.fail('Old account details must not be requested'),
  });
  authSessionRegistration(service, { generation: 'fixture-session-71' }, { id: 71 }).register();
  const oldRead = service.getAllFullRuns();
  authSessionRegistration(service, { generation: 'fixture-session-72' }, { id: 72 }).register();
  release();
  await assert.rejects(oldRead, /session changed/);
});

test('Auth.js token refresh preserves the existing authenticated session generation', async () => {
  const source = ts.createSourceFile('auth.ts', read('../auth.ts'), ts.ScriptTarget.Latest, true);
  let jwtCallback;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'jwt') jwtCallback = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(jwtCallback);
  const callback = new Function(compile(`${jwtCallback.getText(source).replace(/^async jwt\(/, 'async function jwt(')}\nreturn jwt;`))();
  const token = { id: '71', sessionGeneration: 'fixture-session-71', accessToken: 'synthetic-before', refreshToken: 'synthetic-refresh-before' };
  const refreshed = await callback({ token, trigger: 'update', session: { accessToken: 'synthetic-after', refreshToken: 'synthetic-refresh-after', expiresIn: 900 } });
  assert.equal(refreshed.sessionGeneration, 'fixture-session-71');
  assert.equal(refreshed.accessToken, 'synthetic-after');
});
