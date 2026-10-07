import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const proxy = readFileSync(new URL('../app/backend-api/[...path]/route.ts', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx', import.meta.url), 'utf8');
const service = readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function proxyBudgets() {
  const ast = ts.createSourceFile('route.ts', proxy, ts.ScriptTarget.Latest, true);
  const names = new Set(['isZerodhaSyncRequest', 'getProxyAttemptTimeoutMs', 'getProxyTotalTimeoutMs']);
  const funcs = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(ast)).join('\n');
  const constants = [...proxy.matchAll(/^const (?:ZERODHA_SYNC_PROXY_\w+|DEFAULT_BACKEND_PROXY_\w+|SAFE_FALLBACK_METHODS) = .+;$/gm)].map(m => m[0]).join('\n');
  return vm.runInNewContext(compile(constants + funcs + '\n globalThis.budgets = {getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs, isZerodhaSyncRequest};') + '\nbudgets', { process: {env: {}}, getCapturedPortfolioAnalysisReadScope:()=>null, getResearchHistoryReadScope:()=>null, isSportsEventComparisonsRead:()=>false, isBullpenStageOneExcelDownload:()=>false, isBullpenHistoryRead:()=>false, isBullpenDashboardRead:()=>false, isBullpenAutoLiveRead:()=>false, isBullpen008Read:()=>false, readBoundedTimeout:(_,value)=>value });
}

test('Zerodha sync routes have a bounded budget below the 20s browser deadline', () => {
  const b = proxyBudgets();
  for (const [method,path] of [['GET','zerodha/status'],['GET','zerodha/login-url'],['GET','zerodha/portfolio'],['POST','zerodha/callback'],['POST','zerodha/portfolio/sync']]) {
    assert.equal(b.getProxyAttemptTimeoutMs(method,path),16000);
    assert.equal(b.getProxyTotalTimeoutMs(method,path),18000);
  }
  for (const [method,path] of [['POST','zerodha/orders'],['GET','providers'],['GET','zerodha/status/other']]) assert.equal(b.isZerodhaSyncRequest(method,path),false);
  assert.equal(b.getProxyTotalTimeoutMs('GET','providers'),4000);
  for (const method of ['zerodhaLoginUrl','zerodhaStatus','zerodhaPortfolioOverview']) {
    const start = service.indexOf(`  ${method}(`);
    assert.match(service.slice(start, service.indexOf('\n  }',start)), /timeoutMs: CAPTURED_DETAILS_READ_TIMEOUT_MS/);
  }
});

function preflight(apiService) {
  const start = workflow.indexOf('const ensureZerodhaConnectedForSync = useCallback(');
  const end = workflow.indexOf('\n  }, [buildZerodhaPopupFeatures]);',start) + '\n  }, [buildZerodhaPopupFeatures]);'.length;
  return vm.runInNewContext(compile(workflow.slice(start,end) + '\nglobalThis.preflight = ensureZerodhaConnectedForSync;') + '\npreflight', {apiService, useCallback:fn=>fn, buildZerodhaPopupFeatures:()=>''});
}

for (const failure of ['status','login']) {
  test(`a ${failure} preflight failure closes the reserved popup and preserves the error`, async () => {
    const error = new Error('Endpoint unavailable during analysis-only recovery.');
    let closed = 0;
    const popup = {closed:false, close(){this.closed=true;closed++;}};
    const run = preflight({zerodhaStatus:async()=>{if(failure==='status')throw error;return {connected:false};},zerodhaLoginUrl:async()=>{throw error;}});
    await assert.rejects(run(popup), e=>e===error);
    assert.equal(closed,1);
  });
}

test('already connected preflight closes the reserved popup without starting login', async () => {
  let login = false;
  const popup = {closed:false,close(){this.closed=true;}};
  await preflight({zerodhaStatus:async()=>({connected:true}),zerodhaLoginUrl:async()=>{login=true;}})(popup);
  assert.equal(popup.closed,true);
  assert.equal(login,false);
});
