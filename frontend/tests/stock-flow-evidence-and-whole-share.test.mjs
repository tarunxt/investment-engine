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
const identity=load('../lib/rebalanceRunIdentity.ts');
const flow=load('../lib/stockFlowEvidence.ts',{...parser,...identity});
const whole=load('../lib/wholeShareReview.ts');
const selection=load('../lib/zerodhaBasketSelection.ts');
const math=load('../lib/scoreMatrixMath.ts');
const presentation=load('../lib/recommendationAuditPresentation.ts',math);
const threshold=load('../lib/buyThresholdPersistence.ts');
const evidence=load('../components/RecommendationAuditEvidence.tsx',presentation);
const timestamp='2024-02-01T12:00:00Z';
function run(response, status='completed', market='india', id=10) {
  return {id,status,created_at:timestamp,prompt:market==='india'?'Act as an India swing-trading strategist.':'Act as an INDmoney US swing-trading strategist.',run_jobs:[{job_id:id*10,job:{provider:'synthetic',model:'fixture',status,response,created_at:timestamp}}]};
}
const row={'Stock Symbol':'FIXTUREEQ','Exchange Symbol':'NSE','Units to Buy':'5','Price Per Unit':'100','Total Buy Amount':'500','Technical Setup':'Support bounce','Confidence Score (0-100)':'80'};
const json=JSON.stringify({stocks:[row]});
const headers=parser.parseInvestmentRecommendationContent(json).headers;
const markdown=`| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n| ${headers.map(header=>row[header]??'—').join(' | ')} |`;

for(const market of ['india','us']) for(const [format,response] of [['JSON',json],['Markdown',markdown]]) test(`${market} Swing ${format} without Action retains real stock rows and job provenance`,()=>{
  const source=run(response,'completed',market), before=structuredClone(source);
  assert.equal(parser.parseInvestmentRecommendationContent(response).headers.includes('Action (Buy/Add/Sell All/Trim/Hold/Buy New)'),false);
  const actual=flow.buildSwingFlow([source]);
  assert.equal(actual.stocks.length,1);assert.equal(actual.stocks[0].symbol,'FIXTUREEQ');assert.equal(actual.outputs[0].jobId,100);
  assert.equal(actual.outputs[0].state,'populated');assert.equal(actual.outputs[0].actions.size,0);assert.deepEqual(source,before);
});
for(const [status,response,expected] of [
  ['completed','{"stocks":[]}','empty'],['completed','[]','empty'],['completed','| Stock Symbol | Units to Buy |\n|---|---|','empty'],
  ['completed','No stocks today','unparseable'],['completed','{"wrong":{"stocks":[{}]}}','unparseable'],['completed','{"stocks":[{"foo":"bar"}]}','unparseable'],
  ['completed','','missing'],['pending',json,'incomplete'],['failed',json,'failed'],['canceled',json,'failed'],
  ['partial','{"stocks":[]}','partial'],['partial','bad response','partial'],['partial',json,'partial'],
]) test(`job ${status}/${expected} is explicitly classified without fabricating zero stocks`,()=>{
  const source=run(response,status);assert.equal(flow.inspectStockJob(source,source.run_jobs[0]).state,expected);
});
test('duplicates count unique jobs, while exchange identity remains distinct',()=>{
  const a=run(JSON.stringify({stocks:[row,row,{...row,'Exchange Symbol':'BSE'}]}));const b=run(json,'completed','india',11);
  const result=flow.buildSwingFlow([a,b]);assert.equal(result.stocks.length,2);assert.equal(result.stocks.find(stock=>stock.exchange==='NSE').totalSuggestions,2);
});
test('newer pending scan is labeled separately and does not conceal completed rows',()=>{
  const a=run(json),b=run('','pending','india',11);b.created_at='2024-02-02T12:00:00Z';
  const selected=flow.selectFlowStage([b,a],'swing','india');assert.equal(selected.selected.id,10);assert.equal(selected.newerIncomplete.id,11);
  assert.equal(flow.selectFlowStage([run(json,'completed','us')],'swing','india').selected,undefined);
});
test('sequence proof requires exact recorded portfolio and sequence',()=>{
  assert.equal(flow.sameFlowSequence(run(json),run(json)),false);
  const a={...run(json),auto_rebalance_portfolio:'india',auto_rebalance_sequence:7};
  assert.equal(flow.sameFlowSequence(a,{...a,id:11}),true);assert.equal(flow.sameFlowSequence(a,{...a,auto_rebalance_sequence:8}),false);
});
test('older workflow history cannot replace a newer observed stage record or mix costs',()=>{
  const newest={completedAt:'2024-02-02T00:00:00Z',runId:2,count:0},older={completedAt:'2024-02-01T00:00:00Z',runId:1,count:10,cost:99};
  assert.deepEqual(flow.mergeStageEvidence(newest,older),newest);assert.deepEqual(flow.mergeStageEvidence({},older),older);
});
test('one India share cannot silently become an order; US fraction and normal whole-share trims remain available',()=>{
  assert.equal(whole.needsWholeShareTrimReview(1,.5),true);assert.equal(whole.needsWholeShareTrimReview(1,.5,true),false);
  for(const held of [null,0,2,3]) assert.equal(whole.needsWholeShareTrimReview(held,held===null?null:held*.5),false);
  for(const choice of ['required','keep']) {const order={side:'SELL',currentUnits:1,units:null,wholeShareReview:choice};assert.equal(whole.isWholeShareOrderSelectable(order),false);assert.throws(()=>whole.assertWholeShareOrdersReviewed([order]));}
  const exit={side:'SELL',currentUnits:1,units:1,wholeShareReview:'exit'};
  assert.equal(whole.isWholeShareOrderSelectable(exit),true);assert.doesNotThrow(()=>whole.assertWholeShareOrdersReviewed([exit]));
  assert.equal(whole.isWholeShareOrderSelectable({...exit,units:null}),false);
  assert.deepEqual([...selection.buildDefaultZerodhaBasketSelection([{...exit,id:'exit',score:-1.2,explicitSelectionRequired:true}])],[]);
});
const workflowPath='../app/console/dashboard/_components/RebalanceWorkflowSections.tsx';
function basket(api={}) {
  return load(workflowPath,{...whole,apiService:api,ZERODHA_DEFAULT_MARKET_PROTECTION:'-1'},['calculatePercentBasketUnits','applyZerodhaBasketPercent','applyZerodhaBasketUnitDelta','applyZerodhaBasketLivePricing','buildZerodhaKiteBasketPayload','buildZerodhaKiteClipboardText','prepareZerodhaBasketOrdersForKite'],true);
}
const blocked={id:'one',symbol:'FIXTUREEQ',exchange:'NSE',side:'SELL',action:'Trim',currentUnits:1,baseUnits:1,units:null,wholeShareReview:'required',price:100,lastPrice:100,amount:null,percent:0,availableBalance:0,orderKind:'Limit'};
test('actual basket percentage, unit, pricing and export functions retain the no-order gate',()=>{
  const b=basket();assert.equal(b.calculatePercentBasketUnits(1,50),null);assert.equal(b.calculatePercentBasketUnits(3,50),1);assert.equal(b.calculatePercentBasketUnits(1,50,true),.5);
  assert.equal(b.applyZerodhaBasketPercent(blocked,100).units,null);assert.equal(b.applyZerodhaBasketUnitDelta(blocked,1).units,null);
  const priced=b.applyZerodhaBasketLivePricing(blocked,102,102);assert.equal(priced.wholeShareReview,'required');assert.equal(priced.units,null);assert.equal(priced.action,'Trim');
  assert.throws(()=>b.buildZerodhaKiteBasketPayload([blocked],true));assert.throws(()=>b.buildZerodhaKiteClipboardText([blocked],true));
});
test('actual LTP preparation excludes keep/required rows before the mocked API boundary',async()=>{
  const calls=[];const b=basket({zerodhaPrepareBasketOrders:async body=>{calls.push(body);return {orders:body.orders.map(()=>({price:101,last_price:101}))};}});
  assert.deepEqual(await b.prepareZerodhaBasketOrdersForKite([blocked,{...blocked,id:'keep',wholeShareReview:'keep'}]),[blocked,{...blocked,id:'keep',wholeShareReview:'keep'}]);assert.equal(calls.length,0);
  await b.prepareZerodhaBasketOrdersForKite([blocked,{...blocked,id:'exit',wholeShareReview:'exit',action:'Sell All',units:1}]);assert.equal(calls.length,1);assert.equal(calls[0].orders.length,1);assert.equal(calls[0].orders[0].quantity,1);
});
test('threshold save requires a user change plus confirmed writable preferences',()=>{
  const key=threshold.thresholdSignature(2.5,2.5);
  assert.equal(threshold.shouldSaveThresholds(true,true,key,key),false);assert.equal(threshold.shouldSaveThresholds(true,false,key,threshold.thresholdSignature(3,2.5)),false);
  assert.equal(threshold.shouldSaveThresholds(false,true,key,'changed'),false);assert.equal(threshold.shouldSaveThresholds(true,true,null,'changed'),false);assert.equal(threshold.shouldSaveThresholds(true,true,key,'changed'),true);
});
test('actual threshold effect serializes writes and ignores stale completion',async()=>{
  const source=readFileSync(new URL(workflowPath,import.meta.url),'utf8'), ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback;function find(node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes('shouldSaveThresholds('))callback=node.arguments[0].getText(ast);ts.forEachChild(node,find);}find(ast);
  assert.ok(callback);const compiled=ts.transpileModule(`export const effect=${callback}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const queue={current:Promise.resolve()},saved={current:threshold.thresholdSignature(2.5,2.5)}, calls=[],resolvers=[],states=[],timers=[],pending={current:0};
  function setup(value,writable=true){const bindings={...threshold,buyThresholdPreferencesLoaded:true,buyThresholdPreferencesWritable:writable,savedBuyThresholdSignature:saved,buyThresholdSaveQueue:queue,pendingBuyThresholdSaves:pending,zerodhaBasketBuyThreshold:value,indmoneyBasketBuyThreshold:2.5,window:{setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{}},setBuyThresholdSaveError:()=>{},setBuyThresholdPersistence:value=>states.push(value),setBuyThresholdPreferencesWritable:()=>{},normalizeError:String,apiService:{updateProfile:body=>{calls.push(body);return new Promise(resolve=>resolvers.push(resolve));}}};const loadedModule={exports:{}};new Function('exports',...Object.keys(bindings),compiled)(loadedModule.exports,...Object.values(bindings));return loadedModule.exports.effect();}
  assert.equal(setup(2.5),undefined);assert.equal(timers.length,0);assert.equal(setup(3,false),undefined);assert.equal(timers.length,0);
  const cleanA=setup(3);timers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  cleanA();setup(4);timers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1,'B cannot overtake in-flight A');
  resolvers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);assert.equal(calls[1].zerodha_buy_threshold,4);assert.equal(states.includes('saved'),false);
  resolvers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(saved.current,threshold.thresholdSignature(4,2.5));assert.equal(states.at(-1),'saved');
  const cleanC=setup(5);timers.shift()();await new Promise(resolve=>setImmediate(resolve));
  cleanC();setup(4);assert.equal(timers.length,1,'reverting to saved baseline still queues compensation');timers.shift()();
  assert.equal(calls.length,3);resolvers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,4);assert.equal(calls[3].zerodha_buy_threshold,4);
  resolvers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(saved.current,threshold.thresholdSignature(4,2.5));assert.equal(pending.current,0);
});
test('missing frozen predecessor remains insufficient with legacy context, rounded scores and readable timestamps',()=>{
  const current={id:'c',run_id:10,provenance:'legacy_observed',captured_at:timestamp,decision_at:timestamp,original_completion_at:null,calculation:{raw_action:'Sell All',formula_action:'Trim',score:'-1.26',formula_units:'-.5',current_units:'1',findings:[],averages:{}},sizing:{action:'Sell All',units:'-1',findings:[]},coverage:{successful:2,attempted:2},provider_families:[['same','family']]};
  const output=renderToStaticMarkup(React.createElement(evidence.RecommendationAuditEvidence,{comparison:{current,previous:null,coverage:{},comparison:null},verification:{verdict:'supported',status:'completed',result:null},runId:10,runCount:1,market:'india',currentScore:-1.46666666,currentAction:'Trim',currentUnits:1,currentFormulaUnits:-.5,legacyHistory:[{run_id:9,timestamp,action:'Buy New',score:2.8333333,coverage:'saved_suggestion',origin:'saved_suggestion'}]}));
  assert.match(output,/Quick overview of findings/);assert.match(output,/In-depth details/);assert.match(output,/Insufficient evidence/);assert.doesNotMatch(output,/Supported within the checked scope|1\.466666|2\.833333|bg-green/);assert.match(output,/-1\.47/);assert.match(output,/2\.83/);assert.match(output,/IST/);assert.match(output,/Prior frozen snapshot missing/);assert.match(output,/Whole-share choice required/);
});

test('every Captured Stock Details entrypoint receives the active formula settings',()=>{
  for(const relative of [workflowPath,'../app/console/_components/FinalActionablesConsole.tsx']) {
    const source=readFileSync(new URL(relative,import.meta.url),'utf8'),ast=ts.createSourceFile('entry.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    let count=0;function inspect(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='StockDetailsButton'){count++;assert.ok(node.attributes.properties.some(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(ast)==='formulaConfig'),relative+' has an entrypoint without active settings');}ts.forEachChild(node,inspect);}inspect(ast);assert.ok(count>0);
  }
});

test('unknown current quantities do not silently borrow saved whole-share context',()=>{
  const current={run_id:10,calculation:{current_units:'1',formula_units:'-.5',score:'-1.26',findings:[]},sizing:{findings:[]},coverage:{successful:2,attempted:2}};
  const output=renderToStaticMarkup(React.createElement(evidence.RecommendationAuditEvidence,{comparison:{current,previous:null,coverage:{},comparison:null},verification:null,runId:10,runCount:1,market:'india',currentScore:-1.4,currentAction:'Trim',currentUnits:null,currentFormulaUnits:null}));
  assert.doesNotMatch(output,/Whole-share choice required|Selling one share would exit the entire position/);
});
