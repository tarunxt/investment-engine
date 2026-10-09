import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/backend-api/[...path]/route.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['isZerodhaSyncRequest', 'getProxyAttemptTimeoutMs', 'getProxyTotalTimeoutMs']);
const funcs = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(ast)).join('\n');
const constants = [...source.matchAll(/^const (?:ZERODHA_PROTECTED_ORDER_TIMEOUT_MS|ZERODHA_SYNC_PROXY_\w+|DEFAULT_BACKEND_PROXY_\w+|SAFE_FALLBACK_METHODS) = .+;$/gm)].map(m => m[0]).join('\n');
const js = ts.transpileModule(constants + funcs + '\n globalThis.budgets = {getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs};', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const budgets = vm.runInNewContext(js + '\nbudgets', {process:{env:{}}, getCapturedPortfolioAnalysisReadScope:()=>null, getResearchHistoryReadScope:()=>null, isSportsEventComparisonsRead:()=>false, isBullpenStageOneExcelDownload:()=>false, isBullpenHistoryRead:()=>false, isBullpenDashboardRead:()=>false, isBullpenAutoLiveRead:()=>false, isBullpen008Read:()=>false, readBoundedTimeout:(_,value)=>value});

test('protected-order deadlines cover sell completion without broadening other mutations', () => {
  for (const fn of Object.values(budgets)) {
    for (const path of ['zerodha/orders/place-protected-market','zerodha/orders/place-protected-market-sequenced']) assert.equal(fn('POST',path),180000);
    assert.ok(fn('POST','zerodha/orders') < 30000);
    assert.ok(fn('POST','zerodha/orders/place-protected-market-sequenced/unknown') < 30000);
    assert.ok(fn('GET','zerodha/orders/place-protected-market-sequenced') < 30000);
  }
});
