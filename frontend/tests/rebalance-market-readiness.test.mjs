// DATA-ERROR-20261102-01: paired presentation against the unchanged actual input contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require=createRequire(import.meta.url),cache=new Map();
const root=new URL('../',import.meta.url);
function load(relative){
 if(cache.has(relative))return cache.get(relative);
 const source=readFileSync(new URL(relative,root),'utf8');const mod={exports:{}};cache.set(relative,mod.exports);
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(name=>name.startsWith('@/')?load(name.slice(2)+(name.endsWith('RebalanceReadiness')?'.tsx':'.ts')):require(name),mod,mod.exports);return mod.exports;
}
const {buildRebalanceInputBundle}=load('lib/rebalance.ts');
const {RebalanceReadiness}=load('app/console/_components/RebalanceReadiness.tsx');
const india={holdings:[],holdings_count:0,available_margin:0,positions:{net:[]},captured_at:'2020-01-01T00:00:00Z'};
const us={holdings:[{symbol:'SYNTH',quantity:0}],reported_holdings_count:1,parse_status:'parsed',captured_at:'2020-01-01T00:00:00Z'};
const validate=(market,portfolio)=>{try{buildRebalanceInputBundle({market,portfolio,swingRuns:[],threats:null,previousClose:new Date('2026-11-01'),now:new Date('2026-11-02')});return null;}catch(e){return e.message;}};
test('validator and submission guard source remain byte-for-byte unchanged',()=>{
 const current=readFileSync(new URL('lib/rebalance.ts',root));const baseline=execFileSync('git',['show','8d25f34a:frontend/lib/rebalance.ts'],{cwd:new URL('../../',import.meta.url)});assert.deepEqual(current,baseline);
 const caller=readFileSync(new URL('app/console/_components/PortfolioRebalanceConsole.tsx',root),'utf8');assert.match(caller,/<RebalanceReadiness\s+market=\{market\}/);assert.match(caller,/submitBlockedReason=\{inputError\}/);
});
for(const market of ['india','us'])for(const state of ['loading','empty','error','partial','stale']){
 test(`${market}/${state}: accurate copy preserves current eligibility and unknown distinctions`,()=>{
  const portfolio=state==='empty'?null:state==='partial'?(market==='india'?{...india,available_margin:null}:{...us,reported_holdings_count:2}):market==='india'?india:us;
  const before=JSON.stringify(portfolio);const contractError=validate(market,portfolio);
  const blockedReason=state==='loading'?'Loading rebalance inputs…':state==='error'?'Synthetic read failed':contractError;
  const props={market,loading:state==='loading',error:state==='error'?'Synthetic read failed':null,portfolio,threats:null,selectedSwingCount:0,blockedReason};
  const html=renderToStaticMarkup(React.createElement(RebalanceReadiness,props));
  assert.equal(JSON.stringify(portfolio),before);
  if(market==='india'){assert.match(html,/India holdings, when supplied/);assert.match(html,/missing India snapshot is allowed/);assert.doesNotMatch(html,/US holdings must/);}else{assert.match(html,/US holdings must pass/);assert.doesNotMatch(html,/missing India snapshot is allowed/);}
  assert.equal(html.includes('Execution blocked:'),Boolean(blockedReason));assert.equal(validate(market,portfolio),contractError);
  if(state==='empty')assert.equal(Boolean(contractError),market==='us');
  if(state==='partial')assert.ok(contractError);
  if(state==='stale')assert.equal(contractError,null); // No freshness policy invented.
 });
}
