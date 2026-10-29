import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
function load(relative, bindings = {}, exports = [], functionsOnly = false) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const text = ast.statements.filter(node => functionsOnly ? ts.isFunctionDeclaration(node) : !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
  const compiled = ts.transpileModule(text + `\nexport { ${exports.join(',')} };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loadedModule = { exports: {} }, names = Object.keys(bindings).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key));
  new Function('require','module','exports',...names,compiled)(require,loadedModule,loadedModule.exports,...names.map(key=>bindings[key]));
  return loadedModule.exports;
}
const colors=load('../lib/actionColorScheme.ts');
const parser=load('../components/InvestmentRecommendationTable.tsx',{...React,...colors});

const coverage=load('../lib/stockFlowCoverage.ts',parser);
const table = symbol => `| Exchange Symbol | Stock Symbol | Units to Buy | Price Per Unit | Total Buy Amount |
| --- | --- | --- | --- | --- |
| NSE | ${symbol} | 1 | 100 | 100 |`;
const block=(id,date,job,symbol)=>`## Swing Trade Run #${id}
Created: ${date}; export sheet: test
### #${id} | Job #${job} | provider/model | completed
${table(symbol)}`;
test('saved Swing groups preserve exact jobs, timestamp and newest-first ordering',()=>{
 const prompt=`## 2. Completed Swing Trade Runs Explicitly Selected
${block(443,'2026-10-28T12:00:00Z',2227,'DIXON')}
${block(446,'2026-10-29T12:00:00Z',2232,'TCS')}
## 3. Latest Threats Report
${table('NOT_INPUT')}`;
 const runs=[{prompt},{prompt}],before=structuredClone(runs);
 const result=coverage.savedSwingInputs(runs);
 assert.deepEqual(result.map(x=>x.runId),[446,443]);
 assert.equal(result[0].createdAt,'2026-10-29T12:00:00Z');
 assert.deepEqual(result[1].jobs.map(x=>x.jobId),[2227]);
 assert.deepEqual(result[1].jobs[0].symbols,['NSE:DIXON']);
 assert.deepEqual(runs,before);
});
test('coverage retains all excluded listings without synthesizing formula scores or orders',()=>{
 const universe=['NSE:BEL','BSE:BEL','NSE:MISSING'].map(key=>({key,symbol:key.split(':')[1],exchange:key.split(':')[0],actions:key.endsWith('MISSING')?{}:{'1:2':'Hold'},reasons:{},sources:[],relatedVenues:[]}));
 const result=coverage.uncoveredFinalListings(universe,[{stock:{exchange:'BSE',symbol:'BEL'}}]);
 assert.deepEqual(result.map(x=>x.key),['NSE:BEL','NSE:MISSING']);
 assert.deepEqual(result.map(x=>x.disposition),['No trade','Not actionable']);
 assert.ok(result.every(x=>!('formulaScore' in x)&&!('units' in x)));
});
