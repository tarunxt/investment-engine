import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as React from 'react';
const require = createRequire(import.meta.url);
let sharedColumnBindings = {};
function load(path, bindings={}) { bindings = { ...sharedColumnBindings, BasketMetricPopup: () => null, BasketActionSizingPopup: () => null, ...bindings }; const source=readFileSync(new URL(path,import.meta.url),'utf8'), ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX); const text=ast.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(ast)).join('\n'); const output=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText; const result={exports:{}}; new Function('exports','module','require',...Object.keys(bindings),output)(result.exports,result,require,...Object.values(bindings));return result.exports; }
sharedColumnBindings = load('../lib/basketColumnPreferences.ts');
const draftMath=load('../lib/basketEditableDraft.ts');
const math=load('../lib/basketDisplayCalculations.ts');
const dateMath=load('../lib/datetime.ts');
Object.assign(math,load('../lib/basketActionSizing.ts',math));
const end='2026-10-28T12:00:00Z', start='2026-10-23T12:00:00Z';
const observation=(run,score,overrides={})=>({id:run,run_id:run,symbol:'HAL',exchange:'NSE',covered_at:end,score,completed:true,coverage_status:'suggested',...overrides});
const history=(rows)=>({market:'india',symbols:['HAL'],as_of:end,window_start:start,timezone:'Asia/Kolkata',days:5,truncated:false,observations:rows,notes:[]});
test('history mean uses all valid completed-run observations, exact venue and half-open rolling window',()=>{
 const rows=[observation(1,3),observation(2,1),observation(3,-1,{covered_at:'2026-10-27T12:00:00Z'}),observation(4,99,{completed:false}),observation(5,null),observation(6,9,{exchange:'BSE'}),observation(7,5,{covered_at:start}),observation(8,5,{covered_at:'2026-10-28T12:00:01Z'}),observation(1,3)];
 const mean=math.historicalMean(history(rows),'HAL','NSE');assert.equal(mean.rows.length,3);assert.equal(mean.sum,3);assert.equal(mean.score,1);assert.equal(math.historicalMean(history(rows),'OTHER','NSE').score,null);assert.equal(math.historicalMean({...history(rows),truncated:true},'HAL','NSE').score,null);
});
test('top editable N positives include Hold names, deterministic ties, cap without redistribution and filter-independent denominator',()=>{
 const stocks=[{key:'NSE:C',score:2},{key:'NSE:B',score:2},{key:'NSE:A',score:3},{key:'NSE:D',score:-1},{key:'NSE:E',score:0},{key:'NSE:F',score:null}];
 const p={...math.defaultDisplayParameters(),maximumStocks:2};const result=math.allocateDisplayScores(stocks,p);assert.deepEqual(result.selected.map(s=>s.key),['NSE:A','NSE:B']);assert.equal(result.denominator,5);assert.equal(result.weights.get('NSE:A'),.095);assert.equal(result.weights.has('NSE:C'),false);assert.equal([...result.weights.values()].reduce((a,b)=>a+b,0),.19);
 assert.equal(math.allocateDisplayScores(stocks.map(s=>({...s,score:0})),p).weights.size,0);assert.equal(math.allocateDisplayScores(stocks,{...p,valid:false}).weights.size,0);
});
test('Excel reference examples, nearest whole rounding, fractional USD shares and unavailable assets/LTP',()=>{
 const weight=Math.min(2.39*.95/19.78,.095);const z=math.brokerDisplayAllocation(weight,67545,243,'india');assert.equal(z.stocks,26);assert.equal(z.amount,6318);const us=math.brokerDisplayAllocation(weight,67545,243,'us');assert.equal(us.amount,6417);assert.equal(us.stocks,6417/243);
 const sofi=math.brokerDisplayAllocation(1.87*.95/19.78,67545,625,'us');assert.equal(sofi.amount,6066);assert.equal(math.brokerDisplayAllocation(1.87*.95/19.78,67545,625,'india').amount,6250);
 assert.equal(math.excelRound(2.5),3);assert.equal(math.excelRound(-2.5),-3);assert.equal(math.brokerDisplayAllocation(undefined,67545,243,'india'),null);assert.equal(math.brokerDisplayAllocation(.1,null,243,'us'),null);assert.equal(math.brokerDisplayAllocation(.1,100,0,'india').stocks,null);assert.equal(math.brokerDisplayAllocation(.1,100,null,'us').amount,10);assert.equal(math.brokerDisplayAllocation(.1,0,100,'india').stocks,0);
});
test('inclusive outer-range visibility, Show all and unknown scores do not change financial calculations',()=>{
 for(const score of [-3,-2.5,1.5,3])assert.equal(math.displayScoreAccepted(score,-2.5,1.5,false),true);
 for(const score of [-2.49,0,1.49,null,NaN])assert.equal(math.displayScoreAccepted(score,-2.5,1.5,false),false);assert.equal(math.displayScoreAccepted(null,-2.5,1.5,true),true);
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/lg:grid-cols-3/);assert.match(source,/displayOnlyRows/);assert.match(source,/No executable order/);assert.match(source,/useBasketDisplayCalculations/);
});

function hooks() {
 const slots=[],effects=[];let cursor=0;return { start(){cursor=0;}, unmount(){for(const slot of slots)slot?.cleanup?.();}, flush(){for(const effect of effects.splice(0))effect();}, bindings:{
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
 useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useMemo(fn,deps){const i=cursor++;if(!slots[i]||deps.some((value,index)=>value!==slots[i].deps[index]))slots[i]={deps,value:fn()};return slots[i].value;},
 useEffect(fn,deps){const i=cursor++,prior=slots[i];if(!prior||deps.some((d,n)=>d!==prior.deps[n])){effects.push(()=>{prior?.cleanup?.();slots[i]={deps,cleanup:fn()};});}}
 }};
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;return React.Children.toArray(node.props?.children).map(n=>find(n,predicate)).find(Boolean)??null;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('delayed history, day/scope changes, stale responses and nested calculation dismissal preserve parent state',async()=>{
 const h=hooks(),pending=[];let restored=0;const document={body:{},activeElement:{focus(){restored++;}}};
 const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:params=>new Promise((resolve,reject)=>pending.push({params,resolve,reject}))},createPortal:n=>n,document});
 const stocks=[{symbol:'HAL',exchange:'NSE',score:2.5,ltp:243,ltpAsOf:end,ltpSource:'Zerodha holdings last_price · exact venue'}], render=(open=true,market='india',scope=stocks)=>{h.start();return component.useBasketDisplayCalculations(open,market,scope,67545,end,'Zerodha');};
 let state=render();assert.equal(state.loading,true);h.flush();assert.equal(pending.length,1);pending.shift().resolve(history([observation(1,2)]));await tick();state=render();assert.equal(state.loading,false);
 const historyButton=find(state.cells(stocks[0]),n=>n.props?.['aria-label']==='HAL Historical Weighted Score calculation');historyButton.props.onClick();state=render();assert.equal(state.popupOpen,true);
 assert.match(JSON.stringify(state.popup.props.children), /Zerodha holdings last_price · exact venue/); assert.match(JSON.stringify(state.popup.props.children), /LTP as of/);
 assert.equal(state.popup.props.summary.value, '2'); assert.equal(state.popup.props.summary.metrics[1].value, '1'); state.popup.props.onClose();state=render();assert.equal(state.popupOpen,false);
 state.setParameters({...state.parameters,days:10});state=render();h.flush();const old=pending.shift();assert.equal(old.params.days,10);
 render(true,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);h.flush();old.resolve({...history([observation(2,99)]),days:10,window_start:'2026-10-18T12:00:00Z'});await tick();state=render(true,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);assert.equal(state.loading,true);
 const current=pending.shift();current.resolve({...history([]),market:'us',days:10,window_start:'2026-10-18T12:00:00Z'});await tick();state=render(true,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);assert.equal(state.loading,false);
 render(false,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);h.flush();assert.equal(pending.length,0);
 assert.equal(restored,0);
});


test('calculation popup traps focus, closes only its own layer and restores its opener',()=>{
 const h=hooks();let closed=0,restored=0,focused=0,firstFocused=0,lastFocused=0;
 const opener={focus(){restored++;}},first={focus(){firstFocused++;}},last={focus(){lastFocused++;}},document={body:{},activeElement:opener};
 const {CalculationPopup}=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,apiService:{},createPortal:n=>n,document});
 h.start();const popup=CalculationPopup({title:'HAL Target Zerodha Stocks',children:'actual inputs',onClose(){closed++;}});const panel={focus(){focused++;},querySelectorAll(){return[first,last];}};popup.props.ref.current=panel;h.flush();assert.equal(focused,1);
 let stopped=0,prevented=0;popup.props.children.props.onClick({stopPropagation(){stopped++;}});assert.equal(closed,0);
 document.activeElement=last;popup.props.onKeyDown({key:'Tab',shiftKey:false,preventDefault(){prevented++;},stopPropagation(){stopped++;}});assert.equal(firstFocused,1);
 document.activeElement=first;popup.props.onKeyDown({key:'Tab',shiftKey:true,preventDefault(){prevented++;},stopPropagation(){stopped++;}});assert.equal(lastFocused,1);
 popup.props.onKeyDown({key:'Escape',preventDefault(){prevented++;},stopPropagation(){stopped++;}});assert.equal(closed,1);
 popup.props.onClick({stopPropagation(){stopped++;}});assert.equal(closed,2);h.unmount();assert.equal(restored,1);assert.equal(prevented,3);assert.equal(stopped,5);
});

test('actual parameter edits feed only display inputs, reject invalid drafts and reset with a new scoped instance',()=>{
 const parameterMath=load('../lib/portfolioParameters.ts'),h=hooks(),updates=[];
 const {PortfolioParametersTile}=load('../components/PortfolioParametersTile.tsx',{...parameterMath,...h.bindings,createPortal:n=>n,document:{body:{},activeElement:null}});
 const props={currency:'INR',portfolioValue:100,availableMargin:50,totalAssets:150,capturedAt:end,onDisplayParametersChange:value=>updates.push(value)};
 const render=()=>{h.start();return PortfolioParametersTile(props);};
 render();h.flush();assert.equal(updates.at(-1).maximumStocks,20);assert.equal(updates.at(-1).days,5);
 find(render(),n=>n.props?.['aria-haspopup']==='dialog').props.onClick();render();h.flush();
 find(render(),n=>n.props?.id==='portfolio-parameter-cash').props.onChange({target:{value:'10'}});render();h.flush();assert.equal(updates.at(-1).cash,10);assert.equal(updates.at(-1).normalised,9);
 find(render(),n=>n.props?.id==='portfolio-history-days').props.onChange({target:{value:'10'}});render();h.flush();assert.equal(updates.at(-1).days,10);
 find(render(),n=>n.props?.id==='portfolio-maximum-stocks').props.onChange({target:{value:'30'}});render();h.flush();assert.equal(updates.at(-1).maximumStocks,30);
 find(render(),n=>n.props?.id==='portfolio-history-days').props.onChange({target:{value:''}});render();h.flush();assert.equal(updates.at(-1).valid,false);
 const other=hooks(),otherUpdates=[];const isolated=load('../components/PortfolioParametersTile.tsx',{...parameterMath,...other.bindings,createPortal:n=>n,document:{body:{},activeElement:null}}).PortfolioParametersTile;
 other.start();isolated({...props,onDisplayParametersChange:value=>otherUpdates.push(value)});other.flush();assert.equal(otherUpdates.at(-1).maximumStocks,20);assert.equal(otherUpdates.at(-1).days,5);
});


test('invalid windows, untrusted completion flags and fractional cutoffs never create allocations',()=>{
 assert.equal(math.historicalMean({...history([observation(1,2)]),window_start:'invalid'},'HAL','NSE').score,null);
 assert.equal(math.historicalMean(history([observation(1,2,{completed:'false'})]),'HAL','NSE').score,null);
 assert.equal(math.historicalMean(history([observation(1,4)]),'HAL','NSE').score,null);
 assert.equal(math.allocateDisplayScores([{key:'HAL',score:2}],{...math.defaultDisplayParameters(),maximumStocks:1.5}).weights.size,0);
});

test('display quotes require positive last/market price, exact venue, unique identity and timestamp',()=>{
 const snapshot={captured_at:end,holdings_market_value:100,holdings:[{tradingsymbol:'HAL',exchange:'NSE',last_price:243,average_price:100,close_price:240},{tradingsymbol:'HAL',exchange:'BSE',last_price:245}]};
 assert.deepEqual(math.verifiedDisplayQuote(snapshot,'india','HAL','NSE'),{price:243,asOf:end,source:'Zerodha holdings last_price · exact venue'});
 assert.equal(math.verifiedDisplayQuote(snapshot,'india','HAL','BSE').price,245);
 assert.equal(math.verifiedDisplayQuote({...snapshot,holdings:[{tradingsymbol:'NSE:HAL',exchange:'BSE',last_price:245}]},'india','HAL','BSE'),null);
 assert.equal(math.verifiedDisplayQuote(snapshot,'india','HAL.NS','BSE'),null);
 for(const holding of [{tradingsymbol:'HAL',exchange:'NSE',average_price:100},{tradingsymbol:'HAL',exchange:'NSE',close_price:240},{tradingsymbol:'HAL',exchange:'NSE',last_price:0}]) assert.equal(math.verifiedDisplayQuote({...snapshot,holdings:[holding]},'india','HAL','NSE'),null);
 assert.equal(math.verifiedDisplayQuote({...snapshot,holdings:[snapshot.holdings[0]]},'india','HAL','BSE'),null);
 assert.equal(math.verifiedDisplayQuote({...snapshot,captured_at:null},'india','HAL','NSE'),null);
 assert.equal(math.verifiedDisplayQuote({...snapshot,holdings:[snapshot.holdings[0],snapshot.holdings[0]]},'india','HAL','NSE'),null);
 const usd={captured_at:end,parse_status:'parsed',holdings:[{symbol:'ABC',exchange:'NYSE',market_price:40,average_price:20}]};
 assert.equal(math.verifiedDisplayQuote(usd,'us','ABC','NYSE').price,40);
 assert.equal(math.verifiedDisplayQuote(usd,'us','ABC','NASDAQ'),null);
 assert.equal(math.verifiedDisplayQuote({...usd,holdings:[{symbol:'ABC',market_price:40}]},'us','ABC','NYSE'),null);
 assert.equal(math.verifiedDisplayQuote({...usd,holdings:[{symbol:'ABC',exchange:'NYSE',market_price:0,average_price:20}]},'us','ABC','NYSE'),null);
 const workflow=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
 const dialog=workflow.slice(workflow.indexOf('function ScopedZerodhaBasketPreviewDialog'),workflow.indexOf('function IndMoneySnapshotDialog'));
 assert.doesNotMatch(dialog,/snapshotPrices|order\.lastPrice \?\?/);assert.match(dialog,/verifiedDisplayQuote/);
});

function callback(name,bindings){const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let initializer;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===name)initializer=n.initializer.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(initializer,name);const output=ts.transpileModule(`export const value=${initializer}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const result={exports:{}};new Function('exports','module',...Object.keys(bindings),output)(result.exports,result,...Object.values(bindings));return result.exports.value;}
test('actual filtered-group handlers toggle only visible selectable IDs and preserve hidden selections for both brokers',()=>{
 for(const [broker,cap]of[['zerodha','Zerodha'],['indmoney','Indmoney']]){
  const orders=[{id:'A',action:'Buy New',selectable:true},{id:'B',action:'Buy New',selectable:true},{id:'locked',action:'Buy New',selectable:false},{id:'other',action:'Trim',selectable:true}];let selected=new Set(['A']);
  const fn=callback(`toggle${cap}BasketSection`,{useCallback:fn=>fn,[`${broker}BasketOrders`]:orders,[`setSelected${cap}BasketIds`]:fn=>{selected=fn(selected);},getZerodhaBasketActionForPercent:row=>row.action,isWholeShareOrderSelectable:row=>row.selectable,...math});
  fn('Buy New',['A']);assert.deepEqual([...selected],[]);assert.equal(selected.has('B'),false);
  selected=new Set(['B']);fn('Buy New',['A','locked','display-only','other']);assert.deepEqual([...selected].sort(),broker==='zerodha'?['A','B','display-only','locked','other']:['A','B']);
  fn('Buy New',[]);assert.deepEqual([...selected].sort(),broker==='zerodha'?['A','B','display-only','locked','other']:['A','B']);
  const all=callback(`toggleAll${cap}BasketOrders`,{useCallback:fn=>fn,[`${broker}BasketOrders`]:orders.filter(o=>o.selectable),[`setSelected${cap}BasketIds`]:fn=>{selected=fn(selected);},isWholeShareOrderSelectable:row=>row.selectable});
  selected=new Set(['B']);all();assert.deepEqual([...selected].sort(),['A','B','other']);all();assert.equal(selected.size,0);
 }
});

test('actual preparation callbacks clear prior display scope on reopen/failure and ignore stale completions for both brokers',async()=>{
 for(const [broker,cap,market]of[['zerodha','Zerodha','india'],['indmoney','Indmoney','us']]){
  const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
  const begin=source.indexOf(`  const open${cap}BasketPreview =`),endIndex=source.indexOf('\n  }, [',begin),body=source.slice(begin,endIndex);
  const state={},pending=[],generation={current:0},bindings={useCallback:fn=>fn,[`${broker}Preparation`]:generation,scoreMatrixFormulaConfig:{},zerodhaBasketBuyThreshold:2.5,indmoneyBasketBuyThreshold:2.5,
   fetchRebalanceStockFlowSource:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),apiService:{zerodhaStatus:async()=>({}),zerodhaLoginUrl:async()=>({}),zerodhaEventsLatest:async()=>({analysis:null}),zerodhaThreatsLatest:async()=>({analysis:null}),indmoneyUsEventsLatest:async()=>({analysis:null}),indmoneyUsThreatsLatest:async()=>({analysis:null})},
   getIndiaMarketStatus:()=>({open:false}),getLatestMatchingRebalanceRuns:runs=>runs,buildConsensusRows:runs=>runs,buildTechnicalScanMap:()=>({}),parseTimestampMs:Date.parse,buildDashboardActionRows:stocks=>stocks,buildZerodhaBasketPreviewOrders:rows=>rows.map(row=>({...row,id:`zerodha:${row.id}`})),getZerodhaBasketSelectableOrders:rows=>rows,buildDefaultZerodhaBasketSelection:rows=>new Set(rows.map(row=>row.id)),normalizeError:error=>error.message};
  for(const setter of new Set(body.match(/set[A-Z]\w+/g)))bindings[setter]=value=>{state[setter]=typeof value==='function'?value(state[setter]):value;};
  const prepare=callback(`open${cap}BasketPreview`,bindings);
  const success=prepare();pending.shift().resolve({runs:[{id:'first'}],portfolioSnapshot:{captured_at:end,market}});await success;
  assert.equal(state[`set${cap}AllocationUniverse`][0].id,'first');
  const failed=prepare();assert.deepEqual(state[`set${cap}AllocationUniverse`],[]);assert.equal(state[`set${cap}BasketDetailsData`].portfolioSnapshot,null);pending.shift().reject(new Error('new source failed'));await failed;
  assert.deepEqual(state[`set${cap}AllocationUniverse`],[]);assert.deepEqual(state[`set${cap}BasketOrders`],[]);assert.equal(state[`set${cap}BasketDetailsData`].portfolioSnapshot,null);assert.match(state[`set${cap}BasketError`],/new source failed/);
  const stale=prepare(),old=pending.shift(),fresh=prepare(),latest=pending.shift();latest.resolve({runs:[{id:'new-scope'}],portfolioSnapshot:{captured_at:'2026-10-29T12:00:00Z',market}});await fresh;old.resolve({runs:[{id:'stale'}],portfolioSnapshot:{captured_at:end,market}});await stale;assert.equal(state[`set${cap}AllocationUniverse`][0].id,'new-scope');
  const cached=prepare();pending.shift().resolve({runs:[{id:'cached'}],portfolioSnapshot:{captured_at:end,market},warning:'fresh source unavailable'});await cached;assert.deepEqual(state[`set${cap}AllocationUniverse`],[]);assert.match(state[`set${cap}BasketError`],/cached source/);
  const closing=prepare(),last=pending.shift();generation.current++;last.resolve({runs:[{id:'dismissed'}],portfolioSnapshot:{captured_at:end,market}});await closing;assert.deepEqual(state[`set${cap}AllocationUniverse`],[]);
 }
});


test('same-scope reopen hides prior-generation scores and allocations until deferred success or failure',async()=>{
 for(const outcome of ['success','failure']){
  const h=hooks(),pending=[];
  const {useBasketDisplayCalculations: calculate}=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:params=>new Promise((resolve,reject)=>pending.push({params,resolve,reject}))},createPortal:n=>n,document:{body:{},activeElement:null}});
  const stock={symbol:'HAL',exchange:'NSE',score:2,ltp:243},stocks=[stock];
  const render=(open=true,scope=stocks)=>{h.start();return calculate(open,'india',scope,67545,end,'Zerodha');};
  let state=render();h.flush();pending.shift().resolve(history([observation(1,2)]));await tick();state=render();assert.equal(state.loading,false);assert.match(JSON.stringify(state.cells(stock)),/6318|6,318/);
  render(false);h.flush();render(true,[]);h.flush();state=render();
  assert.equal(state.loading,true,'returning identical scope must not match prior request');
  assert.doesNotMatch(JSON.stringify(state.cells(stock)),/6318|6,318|9\.5%/);assert.match(JSON.stringify(state.cells(stock)),/Loading/);
  h.flush();state=render();assert.equal(pending.length,1);assert.equal(state.loading,true);assert.equal(state.error,undefined);
  if(outcome==='success'){pending.shift().resolve(history([observation(2,1)]));await tick();state=render();assert.equal(state.loading,false);const score=find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Historical Weighted Score calculation');assert.equal(score.props.children,'1.0');}
  else {pending.shift().reject(new Error('reopen source failed'));await tick();state=render();assert.equal(state.loading,false);assert.equal(state.error,'reopen source failed');assert.doesNotMatch(JSON.stringify(state.cells(stock)),/6318|6,318|9\.5%/);assert.match(JSON.stringify(state.cells(stock)),/Unavailable/);}
 }
});

test('actual broker preview renders US copy and labels without India routing controls and preserves handlers',()=>{
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ScopedZerodhaBasketPreviewDialog');assert.ok(node);
 const output=ts.transpileModule(`${node.getText(ast)}\nexport {ScopedZerodhaBasketPreviewDialog};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const Button=props=>React.createElement('button',props,props.children),stub=()=>null;
 let sizingAssets;let providerQuotes=[];const tileComponent=()=>null;
 const bindings={basketActionGroup:math.basketActionGroup,...draftMath,BasketDraftUnits:props=>React.createElement("div",{},props.children),BasketColumnTable:props=>props.children,kiteWeightContext:math.kiteWeightContext,kiteHoldingQuantity:math.kiteHoldingQuantity,stockIdentity:math.stockIdentity,validDisplayPrice:math.validDisplayPrice,useBasketDisplayQuotes:()=>({quotes:[],upstoxQuotes:providerQuotes,loading:false}),verifiedFetchedDisplayQuote:math.verifiedFetchedDisplayQuote,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useEffect:()=>{},useBasketDisplayCalculations:(_open,_market,_stocks,assets)=>{sizingAssets=assets;return({popupOpen:false,showAll:true,lower:-2,upper:1.5,cells:()=>Array.from({length:9},(_,i)=>React.createElement("td",{key:i},"derived")),headers:null,controls:null,popup:null,setParameters:()=>{}});},portfolioParameterMargin:snapshot=>snapshot?.available_margin ?? null,portfolioParameterAssets:()=>({portfolioValue:100,availableMargin:0,totalAssets:100}),verifiedDisplayQuote:()=>null,displayScoreAccepted:()=>true,isWholeShareOrderSelectable:()=>true,getZerodhaAvailableMarginToneClass:()=>'',getIndiaMarketStatus:()=>({open:false,label:'NSE/BSE closed → Zerodha AMO'}),ZERODHA_BASKET_SECTION_ORDER:['Buy New'],ZERODHA_BASKET_SECTION_LABELS:{'Buy New':'Buy New'},getZerodhaBasketActionForPercent:order=>order.action,compareZerodhaBasketOrdersByScore:()=>0,parseTimestampMs:Date.parse,formatTimestamp:v=>v,formatCompactQuoteTime:dateMath.formatCompactQuoteTime,formatBasketCurrency:(value,currency)=>`${currency} ${value}`,formatZerodhaLtpRefreshTime:()=>'',formatBasketQuantity:String,formatBasketPercent:String,getZerodhaBasketUnitLimit:()=>null,ZERODHA_ORDER_KINDS:['Market'],Fragment:React.Fragment,Button,cn:(...v)=>v.filter(Boolean).join(' '),Info:stub,X:stub,Loader2:stub,TradingViewUrlListButton:stub,TradingViewSymbolLink:props=>React.createElement('span',null,props.children),PortfolioParametersTile:tileComponent,ScoreMatrixModal:stub,StockDetailsButton:stub,ScoreMatrixButton:stub,ConsensusBreakupButton:stub,WholeShareTrimChoice:stub};
 const result={exports:{}};new Function('exports','module','require',...Object.keys(bindings),output)(result.exports,result,require,...Object.values(bindings));
 const props={open:true,loading:false,error:null,orders:[{id:'row',symbol:'ABC',exchange:'NASDAQ',action:'Buy New',side:'BUY',units:1,lastPrice:20,price:20,amount:20,percent:100,orderKind:'Market',stock:{},detail:{calculatedScore:2}}],selectedIds:new Set(),detailsData:{portfolioSnapshot:null},historicalRows:[],formulaConfig:{},buyThreshold:2.5,buyThresholdDraft:'2.50',onBuyThresholdDraftChange:()=>{},onClose:()=>{},onToggle:()=>{},onToggleAll:()=>{},onToggleSection:()=>{},onUnitsChange:()=>{},onPercentChange:()=>{},onOrderKindChange:()=>{},onExecutionModeChange:()=>{},onRefreshLtp:()=>{},onFormulaConfigChange:()=>{},executionMode:'publisher_limit',placing:false,directMarketAvailable:false,submission:null,ltpRefreshing:false,ltpRefreshedAt:null};
 let executions=0;const onPlaceOrder=()=>{executions++;};
 const us=result.exports.ScopedZerodhaBasketPreviewDialog({...props,tradingViewMarket:'us',basketBrokerLabel:'IndMoney',basketTitle:'IndMoney Final Order Basket',previewLabel:'IndMoney Basket Preview',primaryButtonLabel:'Final Order',basketCurrency:'USD',onPlaceOrder});
 const {renderToStaticMarkup}=require('react-dom/server');const html=renderToStaticMarkup(us);
 assert.doesNotMatch(html,/Zerodha|NSE\/BSE|AMO|Kite|Protected LIMIT|Execution Mode|Refresh LTP/);
 assert.match(html,/IndMoney US basket review/);assert.match(html,/Select or deselect Buy New IndMoney basket orders/);assert.match(html,/USD/);assert.equal(executions,0);
 const button=find(us,n=>n.type===Button);assert.ok(button);assert.equal(typeof button.props.onClick,'function');
 const india=result.exports.ScopedZerodhaBasketPreviewDialog({...props,tradingViewMarket:'india',basketBrokerLabel:'Zerodha',onPlaceOrder});
 const valuationFixture={captured_at:end,snapshot_date:'2026-10-28',holdings_count:2,holdings_market_value:500,available_margin:1000,holdings:[{exchange:'NSE',tradingsymbol:'HAL',quantity:5,t1_quantity:2,last_price:100},{exchange:'BSE',tradingsymbol:'OIL',quantity:0,t1_quantity:3,last_price:200}]};
 const valued=result.exports.ScopedZerodhaBasketPreviewDialog({...props,detailsData:{portfolioSnapshot:valuationFixture},tradingViewMarket:'india',basketBrokerLabel:'Zerodha',onPlaceOrder});
 const tile=find(valued,node=>node.type===tileComponent);assert.equal(tile.props.portfolioValue,1300);assert.equal(tile.props.availableMargin,1000);assert.equal(tile.props.totalAssets,2300);assert.equal(sizingAssets,2300);assert.match(tile.props.valuationNote,/T1/);
 const comparison=math.weightComparison(700,tile.props.totalAssets,.095);assert.equal(comparison.current,700/2300);assert.equal(comparison.difference,.095-700/2300);assert.equal(math.brokerDisplayAllocation(.095,tile.props.totalAssets,100,'india').stocks,2);
 const indiaHtml=renderToStaticMarkup(india);assert.match(indiaHtml,/NSE\/BSE closed/);assert.match(indiaHtml,/Kite/);assert.match(indiaHtml,/Protected MARKET/);assert.equal(executions,0);
 assert.doesNotMatch(html,/Upstox LTP/);
 assert.match(indiaHtml,/>%<\/th><th[^>]*>Upstox LTP<\/th><th[^>]*>Quoted LTP/);
 assert.match(indiaHtml,/data-provider="upstox"[^>]*>Unavailable/);
 providerQuotes=[{instrument:'NSE:ABC',price:123.45,as_of:end,source:'Upstox exact venue older last trade display only'}];
 const comparisonProps={...props,orders:[{...props.orders[0],exchange:'NSE'}],tradingViewMarket:'india',basketBrokerLabel:'Zerodha',onPlaceOrder};
 const providerHtml=renderToStaticMarkup(result.exports.ScopedZerodhaBasketPreviewDialog(comparisonProps));
 assert.match(providerHtml,/data-provider="upstox"[^>]*><div>INR 123.45/);
 assert.match(providerHtml,/28 Oct: 17:30:00 IST/);assert.match(providerHtml,/older last trade display only/);
 assert.match(providerHtml,/(?:dateTime|datetime)="2026-10-28T12:00:00Z"/);
 assert.doesNotMatch(providerHtml,/Last trade|>Display only</);
 assert.equal(comparisonProps.orders[0].lastPrice,20);assert.equal(comparisonProps.orders[0].units,1);assert.equal(executions,0);
 for(const rows of [[],[{...providerQuotes[0],instrument:'BSE:ABC'}],[{...providerQuotes[0],price:0}],[{...providerQuotes[0],source:'Kite exact venue'}]]){
   providerQuotes=rows;const partial=renderToStaticMarkup(result.exports.ScopedZerodhaBasketPreviewDialog(comparisonProps));assert.match(partial,/data-provider="upstox"[^>]*>Unavailable/);
 }
 providerQuotes=[];
 const popupState=hooks(),UnitsPopup=()=>null;
 const interactiveBindings={...bindings,...popupState.bindings,BasketUnitsPopup:UnitsPopup};
 const interactive={exports:{}};new Function('exports','module','require',...Object.keys(interactiveBindings),output)(interactive.exports,interactive,require,...Object.values(interactiveBindings));
 const usUnitsProps={...comparisonProps,tradingViewMarket:'us'};
 const renderUnits=(next=usUnitsProps)=>{popupState.start();return interactive.exports.ScopedZerodhaBasketPreviewDialog(next);};
 const untouched=structuredClone(comparisonProps.orders);let interactiveTree=renderUnits();popupState.flush();
 for(let iteration=0;iteration<3;iteration++){
   const numberButton=find(interactiveTree,node=>node.props?.['aria-label']==='Explain NSE ABC Units');assert.equal(numberButton.type,'button');assert.equal(numberButton.props['aria-haspopup'],'dialog');numberButton.props.onClick();interactiveTree=renderUnits();
   const popup=find(interactiveTree,node=>node.type===UnitsPopup);assert.ok(popup);assert.equal(popup.props.row,comparisonProps.orders[0]);assert.ok(find(interactiveTree,node=>node.props?.inert===true));popup.props.onClose();interactiveTree=renderUnits();assert.equal(find(interactiveTree,node=>node.type===UnitsPopup),null);assert.deepEqual(comparisonProps.orders,untouched);assert.equal(executions,0);
 }
 find(interactiveTree,node=>node.props?.['aria-label']==='Explain NSE ABC Units').props.onClick();renderUnits({...usUnitsProps,open:false});popupState.flush();interactiveTree=renderUnits();assert.equal(find(interactiveTree,node=>node.type===UnitsPopup),null);
 bindings.ZERODHA_BASKET_SECTION_ORDER.push('Sell All','Trim','Add more');
 const actions=['Sell All','Trim','Buy New','Add more','Hold'];
 const allocationUniverse=actions.map((action,index)=>({id:`display-${index}`,formulaAction:action,formulaScore:index/10,stock:{key:`NSE:FIXTURE${index}`,symbol:`FIXTURE${index}`,exchange:'NSE',rows:[]},detail:{calculatedScore:index/10}}));
 const display=result.exports.ScopedZerodhaBasketPreviewDialog({...props,orders:[],allocationUniverse,tradingViewMarket:'india',basketBrokerLabel:'Zerodha',onPlaceOrder});
 const displayHtml=renderToStaticMarkup(display);for(let i=0;i<actions.length;i++)assert.ok(displayHtml.includes(`FIXTURE${i}`));assert.equal((displayHtml.match(/aria-label="Select NSE FIXTURE/g)??[]).length,5);assert.match(displayHtml,/>Market</);assert.doesNotMatch(displayHtml,/visible selectable selected|display-only/);
 const regroupedBindings={...bindings,basketActionGroup:math.basketActionGroup,actionQuantityMatchesDraft:math.actionQuantityMatchesDraft,useBasketDisplayCalculations:()=>({popupOpen:false,showAll:true,lower:-2,upper:1.5,cells:()=>Array.from({length:9},(_,i)=>React.createElement('td',{key:i},'derived')),headers:null,controls:null,popup:null,setParameters:()=>{},metrics:stock=>({comparison:{action:stock.symbol==='ABC'?'Sell All':'Trim'},actionSizing:{stocks:-5}}),units:()=>React.createElement('button',{},'-5')})};
 const regrouped={exports:{}};new Function('exports','module','require',...Object.keys(regroupedBindings),output)(regrouped.exports,regrouped,require,...Object.values(regroupedBindings));
 const originalHold={formulaAction:'Hold',formulaScore:1,stock:{key:'NSE:ICICIBANK',symbol:'ICICIBANK',exchange:'NSE',rows:[]},detail:{calculatedScore:1}};
 const regroupedTree=regrouped.exports.ScopedZerodhaBasketPreviewDialog({...comparisonProps,selectedIds:new Set(['row']),allocationUniverse:[originalHold]});const regroupedHtml=renderToStaticMarkup(regroupedTree);
 assert.match(regroupedHtml,/Select or deselect Sell All Zerodha basket orders/);assert.match(regroupedHtml,/<span>Trim<\/span>/);assert.match(regroupedHtml,/ICICIBANK/);assert.match(regroupedHtml,/Market/);assert.ok(find(regroupedTree,n=>n.type===Button).props.disabled);assert.equal(comparisonProps.orders[0].side,'BUY');assert.equal(comparisonProps.orders[0].units,1);assert.equal(executions,0);


});

test('current displayed calculation is counted once with complete source-run overlap dedup and eligible other runs',()=>{
 const current={symbol:'HAL',exchange:'NSE',market:'india',score:2.4,calculatedAt:end,sources:[{runId:20,createdAt:end,completed:true,market:'india'},{runId:21,createdAt:'2026-10-28T11:00:00Z',completed:true,market:'india'}]};
 let mean=math.historicalMean(history([]),'HAL','NSE',current);assert.equal(mean.score,2.4);assert.equal(mean.rows.length,1);assert.deepEqual(mean.rows[0].source_run_ids,[20,21]);assert.match(mean.rows[0].formula_version,/Current calculation/);
 const saved=[observation(20,1),observation(21,3),observation(22,1.2),observation(23,2,{covered_at:'2026-10-25T12:00:00Z'}),observation(24,3,{covered_at:start}),observation(25,3,{exchange:'BSE'}),observation(22,1.2)];
 const original=structuredClone(saved);mean=math.historicalMean(history(saved),'HAL','NSE',current);assert.equal(mean.rows.length,3);assert.deepEqual(mean.rows.map(row=>row.run_id),[21,22,23]);assert.ok(Math.abs(mean.score-(2.4+1.2+2)/3)<1e-12);assert.deepEqual(saved,original);
 for(const change of [{score:NaN},{score:4},{symbol:'OTHER'},{exchange:'BSE'},{market:'us'},{calculatedAt:start},{calculatedAt:'2026-10-28T12:00:01Z'},{sources:[]},{sources:[{...current.sources[0],completed:false}]},{sources:[{...current.sources[0],market:'us'}]},{sources:[{...current.sources[0],createdAt:start}]},{sources:[{...current.sources[0],createdAt:'bad'}]}]){
  const read=math.historicalMean(history([observation(20,1)]),'HAL','NSE',{...current,...change});assert.equal(read.score,1,'invalid current context must retain original score without overlap suppression');
 }
 assert.equal(math.historicalMean({...history([]),timezone:'America/New_York'},'HAL','NSE',{...current,calculatedAt:'2026-10-28T08:00:00-04:00'}).score,2.4);
});

test('modern basket current Score appears after saved-history read and disappears on navigation or error',async()=>{
 const h=hooks(),pending=[];
 class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-10-28T11:59:59Z']));} }
 const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,Date:FixedDate,apiService:{getBasketScoreHistory:params=>new Promise((resolve,reject)=>pending.push({params,resolve,reject}))},createPortal:n=>n});
 const stock={symbol:'HAL',exchange:'NSE',score:2.55,ltp:40,scoreSources:[{runId:100,createdAt:'2026-10-28T10:00:00Z',completed:true,market:'india'}]};
 const render=(open=true,market='india',stocks=[stock])=>{h.start();return component.useBasketDisplayCalculations(open,market,stocks,1000,end,'Zerodha');};
 let state=render();assert.equal(state.loading,true);h.flush();pending.shift().resolve(history([]));await tick();state=render();
 const score=find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Historical Weighted Score calculation');assert.equal(score.props.children,'2.6');score.props.onClick();state=render();assert.match(JSON.stringify(state.popup.props.children),/Current calculation/);assert.match(JSON.stringify(state.popup.props.children),/#100/);
 render(false);h.flush();state=render(true,'us',[{...stock,exchange:'NYSE'}]);h.flush();assert.equal(state.loading,true);pending.shift().reject(new Error('different owner/scope read failed'));await tick();state=render(true,'us',[{...stock,exchange:'NYSE'}]);assert.equal(state.error,'different owner/scope read failed');assert.doesNotMatch(JSON.stringify(state.cells({...stock,exchange:'NYSE'})),/2\.55|9\.5%/);
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/scoreSourceRuns=\{zerodhaBasketHistoryRuns\}/);assert.match(source,/scoreSourceRuns=\{indmoneyBasketHistoryRuns\}/);assert.match(source,/row\.stock\.rows\.map\(source => source\.meta\.runId\)/);
});

test('current calculation retains actual displayed action and finite currency display suppresses binary tails without changing arithmetic',()=>{
 for(const action of ['Sell All','Trim','Hold','Add more','Buy New',null,'Invented']){
  const current={symbol:'HAL',exchange:'NSE',market:'india',score:-1.966666666667,action,calculatedAt:end,sources:[{runId:444,createdAt:end,completed:true,market:'india'}]};
  const mean=math.historicalMean(history([]),'HAL','NSE',current);assert.equal(mean.score,current.score);assert.equal(mean.rows[0].action,action==='Invented'?null:action);
 }
 assert.equal(math.formatBasketDisplayCurrency(7403.849999999999,'INR'),'₹7,403.85');assert.equal(math.formatBasketDisplayCurrency(17865.899999999998,'INR'),'₹17,865.90');assert.equal(math.formatBasketDisplayCurrency(-1.25,'USD'),'-$1.25');assert.equal(math.formatBasketDisplayCurrency(0,'USD'),'$0.00');
 for(const value of [null,undefined,NaN,Infinity,-Infinity])assert.equal(math.formatBasketDisplayCurrency(value,'INR'),'—');
 const amount=68*367.95;const before=amount;math.formatBasketDisplayCurrency(amount,'INR');assert.equal(amount,before);
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/action: currentOrder \? getZerodhaBasketActionForPercent\(currentOrder\) : row.formulaAction/);assert.match(source,/return formatBasketDisplayCurrency\(value, currency\)/);
});

test('current score uses authoritative server observation time despite client clock skew and preserves original window timestamps',async()=>{
 for(const offset of [1,-1,1000,-1000,60000,-60000,0]){
  const h=hooks(),pending=[];class ClientDate extends Date {constructor(...args){super(...(args.length?args:[Date.parse(end)+offset]));}}
  const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,Date:ClientDate,apiService:{getBasketScoreHistory:()=>new Promise(resolve=>pending.push(resolve))},createPortal:node=>node});
  const stock={symbol:'HAL',exchange:'NSE',score:2.4,action:'Add more',ltp:100,scoreSources:[{runId:444,createdAt:'2026-10-28T10:00:00Z',completed:true,market:'india'}]};
  const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],1000,end,'Zerodha');};
  let state=render();h.flush();pending.shift()(history([observation(444,3),observation(445,1.2,{covered_at:'2026-10-27T12:00:00Z'}),observation(446,2,{covered_at:start})]));await tick();state=render();
  const score=find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Historical Weighted Score calculation');assert.equal(score.props.children,'1.8',`client offset ${offset}ms`);score.props.onClick();state=render();const text=JSON.stringify(state.popup.props.children);assert.match(text,/server response/);assert.match(text,/#444/);assert.match(text,/#445/);assert.doesNotMatch(text,/#446/);
  state.retry();state=render();h.flush();pending.shift()(history([]));await tick();state=render();assert.equal(find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Historical Weighted Score calculation').props.children,'2.4');
 }
});

test('non-held Buy New sizing uses only verified exact-venue broker quotes, with bounded read-only requests and stale dismissal',async()=>{
 const quote={instrument:'NSE:CDSL',price:1234.5,as_of:end,source:'Broker exact venue server receipt'};
 assert.equal(math.verifiedFetchedDisplayQuote([quote],'CDSL','NSE').price,1234.5);assert.equal(math.verifiedFetchedDisplayQuote([quote],'CDSL','BSE'),null);assert.equal(math.verifiedFetchedDisplayQuote([quote,quote],'CDSL','NSE'),null);
 for(const change of [{price:0},{price:NaN},{price:-1},{as_of:'bad'}])assert.equal(math.verifiedFetchedDisplayQuote([{...quote,...change}],'CDSL','NSE'),null);
 const sized=math.brokerDisplayAllocation(.095,288049.85,quote.price,'india');assert.equal(sized.stocks,22);assert.equal(sized.amount,27159);
 const h=hooks(),pending=[];const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{zerodhaDisplayQuotes:keys=>new Promise((resolve,reject)=>pending.push({keys,resolve,reject}))},createPortal:node=>node});
 const render=(open=true,market='india',keys=['NSE:CDSL'],scope='snapshot-a')=>{h.start();return component.useBasketDisplayQuotes(open,market,keys,scope);};
 let state=render();h.flush();assert.equal(state.loading,true);assert.deepEqual(pending[0].keys,['NSE:CDSL']);render(false);h.flush();pending.shift().resolve({quotes:[quote],missing:[]});await tick();state=render(true,'us');h.flush();assert.deepEqual(state.quotes,[]);assert.equal(pending.length,0);
 state=render();h.flush();pending.shift().resolve({quotes:[quote],missing:[]});await tick();state=render();assert.equal(state.quotes[0].price,1234.5);
 const keys=Array.from({length:120},(_,i)=>`NSE:FIXTURE${i}`);state=render(true,'india',keys);h.flush();assert.equal(pending[0].keys.length,50);pending.shift().resolve({quotes:[],missing:keys.slice(0,50)});await tick();assert.equal(pending[0].keys.length,50);render(false);h.flush();pending.shift().resolve({quotes:[],missing:[]});await tick();assert.equal(pending.length,0);
 state=render();h.flush();pending.shift().reject(new Error('synthetic quote failure'));await tick();state=render();assert.equal(state.error,'synthetic quote failure');assert.deepEqual(state.quotes,[]);state.retry();state=render();h.flush();assert.equal(state.loading,true);pending.shift().resolve({quotes:[quote],missing:[]});await tick();state=render();assert.equal(state.error,undefined);assert.equal(state.quotes[0].price,1234.5);
 state=render(true,'india',['NSE:CDSL'],'snapshot-b');h.flush();const stale=pending.shift();state=render(true,'india',['NSE:CDSL'],'snapshot-c');h.flush();stale.resolve({quotes:[quote],missing:[]});await tick();state=render(true,'india',['NSE:CDSL'],'snapshot-c');assert.equal(state.loading,true);assert.deepEqual(state.quotes,[]);pending.shift().resolve({quotes:[quote],missing:[]});await tick();state=render(true,'india',['NSE:CDSL'],'snapshot-c');assert.equal(state.quotes[0].price,1234.5);
});

test('display sizing prefers valid row Quoted LTP, otherwise labels Limit Price estimate without changing inputs',()=>{
 assert.deepEqual(math.displaySizingPrice(50,40),{price:50,basis:'quoted_ltp',label:'Quoted LTP shown in this row'});
 for(const quoted of [null,undefined,0,-1,NaN,Infinity]){
  const pricing=math.displaySizingPrice(quoted,40);assert.equal(pricing.price,40);assert.equal(pricing.basis,'limit_estimate');assert.match(pricing.label,/not live LTP/);
  const estimate=math.brokerDisplayAllocation(.095,1000,pricing.price,'india');assert.equal(estimate.stocks,2);assert.equal(estimate.amount,80);
 }
 for(const limit of [null,undefined,0,-1,NaN,Infinity]){assert.equal(math.displaySizingPrice(null,limit).price,null);assert.equal(math.brokerDisplayAllocation(.095,1000,math.displaySizingPrice(null,limit).price,'india').stocks,null);}
 const inputs={quoted:null,limit:40};const before={...inputs};math.displaySizingPrice(inputs.quoted,inputs.limit);assert.deepEqual(inputs,before);
});

test('limit-price estimates show their actual price in popup, preserve quote field, and clear across close/reopen',async()=>{
 const h=hooks(),pending=[];const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))},createPortal:node=>node});
 const stock={symbol:'HAL',exchange:'NSE',score:2,ltp:null,limitPrice:40,quoteLoading:true};
 const render=(open=true,rows=[stock])=>{h.start();return component.useBasketDisplayCalculations(open,'india',rows,1000,end,'Zerodha');};
 let state=render();h.flush();pending.shift().resolve(history([observation(1,2)]));await tick();state=render();
 const amount=find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Target Zerodha Amount calculation');assert.equal(amount.props.title,'Estimate using Limit Price; not live LTP');assert.match(JSON.stringify(amount.props.children),/₹80/);assert.doesNotMatch(JSON.stringify(amount.props.children),/Estimate/);amount.props.onClick();state=render();let text=JSON.stringify(state.popup.props.children);assert.match(text,/Estimate using Limit Price; not live LTP/);assert.match(text,/Used price/);assert.equal(stock.ltp,null);assert.equal(stock.limitPrice,40);
 const quoted={...stock,ltp:50,quoteLoading:false};state=render(true,[quoted]);text=JSON.stringify(state.popup.props.children);assert.doesNotMatch(text,/Estimate using Limit Price; not live LTP/);assert.equal(find(state.cells(quoted),node=>node.props?.['aria-label']==='HAL Target Zerodha Amount calculation').props.children,'₹100');
 render(false);h.flush();state=render(true,[{...stock,limitPrice:null,quoteLoading:false}]);h.flush();assert.equal(state.loading,true);pending.shift().resolve(history([observation(2,2)]));await tick();state=render(true,[{...stock,limitPrice:null,quoteLoading:false}]);assert.equal(find(state.cells({...stock,limitPrice:null,quoteLoading:false}),node=>node.props?.['aria-label']==='HAL Target Zerodha Amount calculation').props.children,'Unavailable');
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/limitPrice: tradingViewMarket === "india" \? validDisplayPrice\(order\?\.price\)/);assert.doesNotMatch(source,/ltp:\s*validDisplayPrice\(order\?\.price/);
});

 test('popup final currency results use shared rounding while retaining precise intermediates',async()=>{
 const h=hooks(),pending=[];const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:()=>new Promise(resolve=>pending.push(resolve))},createPortal:node=>node});
 const stock={symbol:'HAL',exchange:'NSE',score:2,ltp:1374.3};
 const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],190000,end,'Zerodha');};
 let state=render();h.flush();pending.shift()(history([observation(1,2)]));await tick();state=render();
 find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Target Zerodha Amount calculation').props.onClick();state=render();
 const text=JSON.stringify(state.popup.props.children);assert.match(text,/₹17,865.90/);assert.doesNotMatch(text,/17,865.899999999998/);
 assert.equal(math.brokerDisplayAllocation(.095,190000,1374.3,'india').amount,13*1374.3);
 const source=readFileSync(new URL('../components/BasketDisplayCalculations.tsx',import.meta.url),'utf8');assert.match(source,/formatBasketDisplayCurrency\(derived\?\.amount, "USD"\)/);
 });

test('partial current source remains usable and overlapping saved runs count only once', () => {
 const current={symbol:'HAL',exchange:'NSE',market:'india',score:2.4,calculatedAt:end,sources:[{runId:447,createdAt:end,completed:false,status:'partial',market:'india'},{runId:448,createdAt:end,completed:true,status:'completed',market:'india'}]};
 const result=math.historicalMean(history([observation(447,1,{completed:false,eligible:true,run_status:'partial'}),observation(440,1.2,{completed:false,eligible:true,run_status:'partial'})]),'HAL','NSE',current);
 assert.equal(result.rows.length,2);assert.ok(Math.abs(result.score-1.8)<1e-12);assert.match(result.rows[0].formula_version,/partially usable/);
 for(const status of ['failed','processing','pending',undefined])assert.equal(math.historicalMean(history([]),'HAL','NSE',{...current,sources:[{...current.sources[0],status}]}).score,null);
 assert.equal(math.historicalMean(history([observation(1,null,{eligible:true,completed:false})]),'HAL','NSE').score,null);
});

test('summary sources show newer retained partial runs without fabricating recorded scores', () => {
 const {mergeSummarySourceRows}=load('../lib/summarySourceRows.ts');
 const saved=[{id:1,rebalance_run_id:400,covered_at:'2026-09-02T12:00:00Z',score:2,coverage_status:'suggested'}];
 const retained=[{runId:447,coveredAt:end,formulaScore:1.7,stock:{symbol:'HAL',exchange:'NSE'}},{runId:400,coveredAt:start,formulaScore:3,stock:{symbol:'HAL',exchange:'NSE'}}];
 const before=structuredClone([saved,retained]);const rows=mergeSummarySourceRows(saved,[...retained,retained[0]]);
 assert.deepEqual(rows.map(row=>[row.runId,row.kind]),[[447,'retained'],[400,'saved']]);assert.equal(rows[0].item.score,undefined);assert.equal(rows[1].item.score,2);assert.deepEqual([saved,retained],before);
 assert.equal(mergeSummarySourceRows([{...saved[0],rebalance_run_id:447,coverage_status:'parse_failed'}],retained).filter(row=>row.kind==='retained').length,2);
});

test('current weights include T1 holdings and cash with exact venue identity',()=>{
 const ctx=math.kiteWeightContext({captured_at:end,holdings_count:2,available_margin:500,holdings:[{exchange:'BSE',tradingsymbol:'OIL',quantity:0,t1_quantity:19,last_price:100},{exchange:'NSE',tradingsymbol:'HAL',quantity:3,t1_quantity:2,last_price:100}]});
 assert.equal(ctx.totalAssets,2900);assert.equal(ctx.values.get('BSE:OIL'),1900);assert.equal(ctx.values.get('NSE:HAL'),500);assert.equal(ctx.values.get('NSE:OIL'),undefined);
 assert.equal(math.weightComparison(ctx.values.get('BSE:OIL'),ctx.totalAssets,.1).current,1900/2900);
 assert.equal(math.kiteWeightContext(null).valid,false);
});
test('weight differences implement all action branches without rounding away small differences',()=>{
 for(const [value,target,action] of [[0,.095,'Buy New'],[10,.2,'Add More'],[20,.1,'Trim'],[20,0,'Sell All'],[20,.2,'Hold'],[0,0,'Hold']]){
  const r=math.weightComparison(value,100,target);assert.equal(r.action,action);assert.equal(r.difference,target-value/100);
 }
 assert.equal(math.weightComparison(20,100,.200001).action,'Add More');
 for(const args of [[null,100,.2],[20,null,.2],[20,0,.2],[20,100,null]]) assert.equal(math.weightComparison(...args).action,null);
});

test('shared settled plus T1 valuation rejects missing inputs and keeps cash, venues and snapshot prices separate',()=>{
 const holding={exchange:'NSE',tradingsymbol:'HAL',quantity:5,t1_quantity:2,last_price:100};const snapshot={captured_at:end,holdings_count:1,available_margin:1000,holdings:[holding]};const before=JSON.stringify(snapshot);
 assert.equal(math.kiteWeightContext(snapshot).portfolioValue,700);assert.equal(math.kiteWeightContext(snapshot).totalAssets,1700);assert.equal(JSON.stringify(snapshot),before);
 for(const change of [{available_margin:null},{captured_at:'bad'},{holdings_count:2},{holdings:[{...holding,t1_quantity:undefined}]},{holdings:[{...holding,t1_quantity:-1}]},{holdings:[{...holding,last_price:0}]},{holdings:[{...holding,exchange:''}]}]){const ctx=math.kiteWeightContext({...snapshot,...change});assert.equal(ctx.valid,false);assert.equal(ctx.totalAssets,null);}
 const cents=math.kiteWeightContext({...snapshot,holdings_count:2,holdings:[{...holding,quantity:1,t1_quantity:0,last_price:.1},{...holding,exchange:'BSE',quantity:1,t1_quantity:0,last_price:.2}]});assert.equal(cents.portfolioValue,.3);assert.equal(cents.values.get('NSE:HAL'),.1);assert.equal(cents.values.get('BSE:HAL'),.2);
});

test('Upstox comparison maps its own API field and clears partial values across scopes',async()=>{
 const h=hooks(),pending=[];
 const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{zerodhaDisplayQuotes:keys=>new Promise(resolve=>pending.push({keys,resolve}))},createPortal:node=>node});
 const render=(scope='owner-a',open=true)=>{h.start();return component.useBasketDisplayQuotes(open,'india',['NSE:ABC','NSE:MISSING'],scope);};
 const kite={instrument:'NSE:ABC',price:20,as_of:end,source:'Kite exact venue'};
 const upstox={...kite,price:25,source:'Upstox exact venue older last trade display only'};
 let state=render();h.flush();pending.shift().resolve({quotes:[kite],upstox_quotes:[upstox],missing:['NSE:MISSING']});await tick();state=render();
 assert.equal(state.quotes[0].price,20);assert.equal(state.upstoxQuotes[0].price,25);assert.equal(state.upstoxQuotes.length,1);
 state=render('owner-b');h.flush();assert.deepEqual(state.upstoxQuotes,[]);pending.shift().resolve({quotes:[kite],missing:['NSE:MISSING']});await tick();state=render('owner-b');assert.deepEqual(state.upstoxQuotes,[]);
 for(const invalid of [null,[{...upstox,instrument:'BSE:ABC'}],[{...upstox,source:'Kite exact venue'}]]){
   state.retry();state=render('owner-b');h.flush();pending.shift().resolve({quotes:[kite],upstox_quotes:invalid,missing:[]});await tick();state=render('owner-b');assert.match(state.error,/Upstox response/);assert.deepEqual(state.upstoxQuotes,[]);
 }
 state=render('owner-b',false);h.flush();assert.deepEqual(state.quotes,[]);assert.deepEqual(state.upstoxQuotes,[]);
});

test('Units explanation uses captured executable rounding and caps, with explicit missing history',()=>{
 const unitMath=load('../lib/basketUnitsExplanation.ts');
 const row={symbol:'HCLTECH',exchange:'NSE',side:'BUY',baseUnits:8.5,currentUnits:0,price:100,availableBalance:700,percent:100,units:7,unitsTrace:{initial:{sourceUnits:8.5,baseUnits:8.5,requestedPercent:100,rawUnits:8.5,roundedUnits:8,cap:7,result:7,price:100},manualAdjusted:false}};
 let result=unitMath.explainBasketUnits(row);assert.equal(result.summary.value,'7');assert.match(result.summary.subtitle,/8.5 × 100% = 8.5.*FLOOR.*8.*cap 7.*7 units/);assert.match(result.summary.notice,/separate from display-only/);
 const adjusted={...row,units:6,unitsTrace:{...row.unitsTrace,manualAdjusted:true,latest:{kind:'Manual Units adjustment',previousUnits:7,requestedUnits:6,roundedUnits:6,cap:7,result:6}}};result=unitMath.explainBasketUnits(adjusted);assert.equal(result.summary.value,'6');assert.match(result.summary.notice,/manual Units adjustment/);assert.equal(result.initial.result,7);
 result=unitMath.explainBasketUnits({...adjusted,units:5});assert.equal(result.reconciles,false);assert.match(result.summary.notice,/not captured/);
 result=unitMath.explainBasketUnits({...row,unitsTrace:undefined,price:null});assert.match(result.summary.subtitle,/unavailable/);assert.equal(result.summary.value,'7');
 result=unitMath.explainBasketUnits({...row,allowFractionalUnits:true,units:8.5,unitsTrace:{initial:{...row.unitsTrace.initial,roundedUnits:8.5,cap:null,result:8.5}}});assert.match(result.summary.subtitle,/Keep fractional units 8.5/);
 const blocked={...row,units:null,wholeShareReview:'required',unitsTrace:{initial:{...row.unitsTrace.initial,result:null}}};assert.match(unitMath.explainBasketUnits(blocked).summary.notice,/Whole-share review: required/);
});

test('real Units sizing functions capture baseline, manual delta, price cap and percent results without changing guards',()=>{
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const names=['calculatePercentBasketUnits','getZerodhaBasketSellUnitLimit','getZerodhaBasketBuyUnitLimit','getZerodhaBasketUnitLimit','clampZerodhaBasketUnits','calculateZerodhaBasketAmount','calculateZerodhaBasketPercent','applyZerodhaBasketUnitDelta','applyZerodhaBasketLivePricing','applyZerodhaBasketPercent','getZerodhaBasketBaseUnits','getBasketPrice','buildZerodhaBasketPreviewOrders'];
 const functions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
 const bindings={ZERODHA_BASKET_ACTIONS:new Set(['Sell All','Trim','Buy New','Add more']),buildZerodhaHoldingExchangeMap:()=>new Map(),buildZerodhaHoldingUnitsMap:()=>new Map(),buildZerodhaSnapshotPriceMap:()=>new Map(),normalizeZerodhaBasketSymbol:String,isExplicitNonBuyDecision:()=>false,needsWholeShareTrimReview:()=>false,getZerodhaBasketExchange:()=> 'NSE',getTechnicalScanForStock:()=>null,compareZerodhaBasketOrdersByScore:()=>0};
 const result={exports:{}};const compiled=ts.transpileModule(`${functions}\nexport {${names.join(',')}}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('exports',...Object.keys(bindings),compiled)(result.exports,...Object.values(bindings));const f=result.exports;
 const rows=[{id:'fixture',formulaAction:'Buy New',formulaEstimate:{units:8.5,currentUnits:0,amount:850},stock:{symbol:'HCLTECH',exchange:'NSE',rows:[],representative:{}},detail:{}}];
 const [initial]=f.buildZerodhaBasketPreviewOrders(rows,{}, {available_margin:700});assert.equal(initial.units,7);assert.equal(initial.unitsTrace.initial.rawUnits,8.5);assert.equal(initial.unitsTrace.initial.roundedUnits,8);assert.equal(initial.unitsTrace.initial.cap,7);assert.equal(initial.unitsTrace.initial.result,7);
 const before=structuredClone(initial),manual=f.applyZerodhaBasketUnitDelta(initial,-1);assert.equal(manual.units,6);assert.equal(manual.unitsTrace.manualAdjusted,true);assert.equal(manual.unitsTrace.latest.previousUnits,7);assert.equal(manual.unitsTrace.initial.result,7);assert.deepEqual(initial,before);
 const capped=f.applyZerodhaBasketLivePricing(manual,200,201);assert.equal(capped.units,3);assert.equal(capped.unitsTrace.latest.cap,3);assert.equal(capped.unitsTrace.latest.result,capped.units);assert.equal(capped.unitsTrace.manualAdjusted,true);
 const percentage=f.applyZerodhaBasketPercent(initial,50);assert.equal(percentage.units,4);assert.equal(percentage.unitsTrace.latest.requestedUnits,4.25);assert.equal(percentage.unitsTrace.latest.roundedUnits,4);assert.equal(percentage.unitsTrace.manualAdjusted,false);
 assert.equal(f.applyZerodhaBasketUnitDelta({...initial,wholeShareReview:'required'},1).units,7);
 const missingPrice=f.applyZerodhaBasketLivePricing(manual,null,null);assert.equal(missingPrice.units,6);assert.equal(missingPrice.amount,null);assert.equal(missingPrice.unitsTrace.latest.cap,null);
});

test('stacked Units summary supports detail/back, Done, Escape and focus containment',()=>{
 const h=hooks(),styles=new Proxy({}, {get:(_target,key)=>String(key)}),icon=()=>null;
 let closed=0,restored=0,firstFocus=0,lastFocus=0,prevented=0;
 const opener={isConnected:true,focus(){restored++;}},document={body:{},activeElement:opener};
 const component=load('../components/BasketMetricPopup.tsx',{...h.bindings,styles,createPortal:node=>node,document,Menu:icon,X:icon,ArrowLeft:icon});
 const props={title:'Units calculation',eyebrow:'NSE:HCLTECH / Zerodha',wide:true,summary:{label:'Executable basket units',value:'7',subtitle:'8.5 → 8 → capped to 7',metrics:[],notice:'Display only'},children:'Actual captured calculation',onClose:()=>{closed++;}};
 const render=()=>{h.start();return component.BasketMetricPopup(props);};let tree=render();const summary=React.Children.toArray(tree.props.children)[0];assert.equal(summary.props.wide,true);assert.equal(summary.props.covered,false);
 const summaryLayer=summary.type(summary.props),section=find(summaryLayer,node=>node.type==='section');
 const first={focus(){firstFocus++;}},last={focus(){lastFocus++;}},panel={focus(){document.activeElement=panel;},contains:node=>node===panel,querySelectorAll:()=>[first,last],querySelector:()=>first};section.props.ref.current=panel;h.flush();assert.equal(document.activeElement,panel);assert.equal(section.props.role,'dialog');assert.equal(section.props['aria-modal'],true);
 const event=(key,shiftKey=false)=>({key,shiftKey,stopPropagation(){},preventDefault(){prevented++;}});document.activeElement=last;summaryLayer.props.onKeyDown(event('Tab'));assert.equal(firstFocus,1);document.activeElement=first;summaryLayer.props.onKeyDown(event('Tab',true));assert.equal(lastFocus,1);
 const menu=summary.props.tools;menu.props.onClick();tree=render();let layers=React.Children.toArray(tree.props.children);assert.equal(layers.length,2);assert.equal(layers[0].props.covered,true);assert.equal(layers[1].props.details,true);assert.equal(layers[1].props.title,'Behind the number');layers[1].props.onClose();tree=render();assert.equal(React.Children.toArray(tree.props.children).length,1);
 const done=React.Children.toArray(tree.props.children)[0].props.footer;done.props.onClick();assert.equal(closed,1);summaryLayer.props.onKeyDown(event('Escape'));assert.equal(closed,2);assert.ok(prevented>=3);h.unmount();assert.equal(restored,1);
});

test('column picker hides complete columns, preserves controls, and keeps its hamburger reachable',()=>{
 const component=load('../components/BasketColumnPicker.tsx',{Children:React.Children,Fragment:React.Fragment,cloneElement:React.cloneElement,isValidElement:React.isValidElement,Menu:()=>null,BasketModalLayer:()=>null});
 const labels=['Selection','Stock','Score','Consensus','Action','Side','Historical Weighted Score','Current Weight','Target Weight','Weight Difference','Action New','Action Zerodha Stocks','Action Zerodha Amount','Target Zerodha Stocks','Target Zerodha Amount','Units','%','Upstox LTP','Quoted LTP','Limit Price','Amount','Order Type','Status'];
 let clicked=0,opened;const table=React.createElement('table',{},React.createElement('thead',{},React.createElement('tr',{},React.createElement(React.Fragment,{},labels.map(label=>React.createElement('th',{key:label},label))))),React.createElement('tbody',{},React.createElement('tr',{},React.createElement('td',{colSpan:21},'Sell All')),React.createElement('tr',{},labels.map(label=>React.createElement('td',{key:label},React.createElement('button',{onClick:()=>clicked++},label))))));
 assert.deepEqual(component.basketTableColumns(table),labels);
 const render=hidden=>component.BasketColumnTable({children:table,hidden,onOpen:value=>{opened=value;}});
 const baseline=render([]);find(baseline,node=>node.props?.['aria-label']==='Choose basket columns').props.onClick();assert.deepEqual(opened,labels);
 for(const hidden of labels){const output=render([hidden]),all=[];function collect(node){if(!node||typeof node!=='object')return;if(node.props?.['data-basket-column']===hidden)all.push(node);React.Children.toArray(node.props?.children).forEach(collect);}collect(output);assert.equal(all.length,2);assert.ok(all.every(cell=>cell.props.hidden===true));assert.ok(find(output,node=>node.props?.['data-column-control']));assert.equal(find(output,node=>node.props?.colSpan).props.colSpan,23);}
 const none=render(labels);assert.equal(find(none,node=>node.props?.colSpan).props.colSpan,1);assert.ok(find(none,node=>node.props?.['aria-label']==='Choose basket columns'));
 const stock=find(baseline,node=>node.props?.['data-basket-column']==='Stock'&&node.type==='td');find(stock,node=>node.type==='button').props.onClick();assert.equal(clicked,1);
 const picker=component.BasketColumnPicker({labels,hidden:['Status'],onToggle:label=>{opened=label;},onClose:()=>{clicked++;}});const status=find(picker,node=>node.type==='label'&&React.Children.toArray(node.props.children).includes('Status'));const input=find(status,node=>node.type==='input');assert.equal(input.props.type,'checkbox');assert.equal(input.props.checked,false);input.props.onChange();assert.equal(opened,'Status');picker.props.onClose();assert.equal(clicked,2);
 const empty=React.createElement('table',{},table.props.children[0],React.createElement('tbody',{},React.createElement('tr',{},React.createElement('td',{colSpan:21},'No basket rows available.'))));assert.ok(find(component.BasketColumnTable({children:empty,hidden:['Status'],onOpen:()=>{}}),node=>node.props?.['aria-label']==='Choose basket columns'));
});

test('Sell All and Trim show actual exact-venue holdings and genuine price preference without sizing orders',async()=>{
 const snapshot={holdings_count:3,captured_at:end,holdings:[{tradingsymbol:'HAL',exchange:'NSE',quantity:3,t1_quantity:1},{tradingsymbol:'HAL',exchange:'NSE',quantity:.5,t1_quantity:.5},{tradingsymbol:'HAL',exchange:'BSE',quantity:99,t1_quantity:0}]};
 const holding=math.kiteHoldingQuantity(snapshot,'HAL','NSE');assert.equal(holding.quantity,5);assert.equal(math.kiteHoldingQuantity(snapshot,'OTHER','NSE').quantity,0);assert.equal(math.kiteHoldingQuantity(null,'HAL','NSE'),null);assert.equal(math.kiteHoldingQuantity({...snapshot,holdings_count:4},'HAL','NSE'),null);assert.equal(math.kiteHoldingQuantity({...snapshot,holdings:[{...snapshot.holdings[0],quantity:NaN}],holdings_count:1},'HAL','NSE'),null);
 for(const action of ['Sell All','Trim']){
   const stock={symbol:'HAL',exchange:'NSE',action,score:-1,currentValue:1000,holdingQuantity:holding.quantity,holdingAsOf:holding.asOf,holdingSource:holding.source,ltp:200,ltpAsOf:end,ltpSource:'Kite exact venue',upstoxLtp:210,upstoxAsOf:end,upstoxSource:'Upstox exact venue',limitPrice:999};
   assert.equal(math.sellHoldingDisplay(stock).amount,1000);assert.equal(math.sellHoldingDisplay({...stock,ltp:null}).amount,1050);assert.equal(math.sellHoldingDisplay({...stock,ltp:null,upstoxLtp:null}).amount,null);assert.equal(math.sellHoldingDisplay({...stock,holdingQuantity:0}).amount,0);assert.equal(math.sellHoldingDisplay({...stock,holdingQuantity:null}).stocks,null);
   const h=hooks();const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:()=>new Promise(()=>{})},createPortal:node=>node});const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],10000,end,'Zerodha');};let state=render();const shares=find(state.cells({symbol:'HAL',exchange:'NSE',score:-1,ltp:200}),node=>node.props?.['aria-label']==='HAL Target Zerodha Stocks calculation');assert.equal(shares.props.children,'5');const amount=find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Target Zerodha Amount calculation');assert.match(amount.props.children,/1,000/);amount.props.onClick();state=render();assert.match(state.popup.props.summary.label,/Current Kite holding value/);assert.match(JSON.stringify(state.popup.props.children),/No Limit Price estimate/);assert.match(state.popup.props.summary.subtitle,/5 ×/);
 }
 for(const action of ['Buy New','Add more','Hold'])assert.equal(math.sellHoldingDisplay({action,holdingQuantity:5,ltp:200}),null);
});

test('Upstox enabled flag comes from owner-scoped capabilities and is dismissed on scope change',async()=>{
 const h=hooks();const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{zerodhaDisplayQuotes:async()=>{throw new Error('prices unavailable');},zerodhaQuoteCapabilities:async()=>({upstox_ltp_enabled:true})},createPortal:node=>node});
 const render=(scope='owner-a')=>{h.start();return component.useBasketDisplayQuotes(true,'india',['NSE:ABC'],scope);};let state=render();assert.equal(state.upstoxEnabled,false);h.flush();await tick();state=render();assert.equal(state.upstoxEnabled,true);assert.equal(state.error,'prices unavailable');state=render('owner-b');assert.equal(state.upstoxEnabled,false);
});

test('column preferences survive the actual keyed basket close/reopen and snapshot remount',()=>{
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const node=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ZerodhaBasketPreviewDialog');const compiled=ts.transpileModule(`${node.getText(ast)}\nexport {ZerodhaBasketPreviewDialog}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const h=hooks(),loaded={exports:{}};new Function('exports','require','useState','useEffect','useAuth','readBasketColumnLayout','writeBasketColumnLayout','emptyBasketColumnLayout','ScopedZerodhaBasketPreviewDialog',compiled)(loaded.exports,require,h.bindings.useState,h.bindings.useEffect,()=>({user:{id:71}}),sharedColumnBindings.emptyBasketColumnLayout,()=>{},sharedColumnBindings.emptyBasketColumnLayout,()=>null);
 const props={open:true,detailsData:{portfolioSnapshot:{captured_at:end}},basketBrokerLabel:'Zerodha',tradingViewMarket:'india'};
 const render=(changes={})=>{h.start();return loaded.exports.ZerodhaBasketPreviewDialog({...props,...changes});};let view=render();const firstKey=view.key;view.props.columnPreferences.toggle('Status');view=render({open:false});assert.notEqual(view.key,firstKey);assert.deepEqual(view.props.columnPreferences.hiddenColumns,['Status']);
 view=render();assert.deepEqual(view.props.columnPreferences.hiddenColumns,['Status']);view=render({detailsData:{portfolioSnapshot:{captured_at:'2026-10-30T12:00:00Z'}}});assert.deepEqual(view.props.columnPreferences.hiddenColumns,['Status']);
 view=render({basketBrokerLabel:'IndMoney',tradingViewMarket:'us'});assert.deepEqual(view.props.columnPreferences.hiddenColumns,[]);view.props.columnPreferences.toggle('Amount');view=render();assert.deepEqual(view.props.columnPreferences.hiddenColumns,['Status']);
 view.props.columnPreferences.toggle('Status');assert.deepEqual(render().props.columnPreferences.hiddenColumns,[]);
});

test('Action New pills follow the displayed derived action and match Side colors',async()=>{
 for(const fixture of [{score:-1,current:200,action:'Sell All',tone:'bg-red-100 text-red-700'},{score:1,current:200,action:'Trim',tone:'bg-red-100 text-red-700'},{score:1,current:0,action:'Buy New',tone:'bg-emerald-100 text-emerald-700'},{score:1,current:10,action:'Add More',tone:'bg-emerald-100 text-emerald-700'},{score:1,current:95,action:'Hold',tone:'bg-slate-100 text-slate-700'}]){
  const h=hooks();const stock={symbol:'HAL',exchange:'NSE',action:'Hold',score:fixture.score,currentValue:fixture.current,ltp:100};const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:async()=>history([observation(1,fixture.score)])},createPortal:node=>node});const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],1000,end,'Zerodha');};let state=render();h.flush();await tick();state=render();const pill=find(state.cells(stock),node=>node.type==='span'&&node.props.children===fixture.action);assert.ok(pill,fixture.action);assert.ok(pill.props.className.includes(fixture.tone));assert.match(pill.props.className,/rounded-full.*font-bold/);
 }
});

test('selection header keeps its checkbox and a usable picker label without visible All Stocks text',()=>{
 const workflow=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.doesNotMatch(workflow,/<span>All Stocks<\/span>/);assert.match(workflow,/aria-label="Select or deselect all basket rows"/);
 const component=load('../components/BasketColumnPicker.tsx',{Children:React.Children,Fragment:React.Fragment,cloneElement:React.cloneElement,isValidElement:React.isValidElement,Menu:()=>null,BasketModalLayer:()=>null});const input=React.createElement('input',{type:'checkbox','aria-label':'Select all basket orders'});const table=React.createElement('table',{},React.createElement('thead',{},React.createElement('tr',{},React.createElement('th',{'data-column-label':'Selection'},input),React.createElement('th',{},'Status'))));assert.deepEqual(component.basketTableColumns(table),['Selection','Status']);const output=component.BasketColumnTable({children:table,hidden:[],onOpen:()=>{}});assert.ok(find(output,node=>node.type==='input'));assert.ok(find(output,node=>node.props?.['aria-label']==='Choose basket columns'));
});

test('action sizing uses signed fractional weight difference, nearest whole shares and a holdings cap',()=>{
 const base={totalAssets:10000,currentWeight:.1,targetWeight:.2,upstoxLtp:400,holdingQuantity:5};
 const buy=math.basketActionSizing(base);assert.equal(buy.rawStocks,2.5);assert.equal(buy.stocks,3);assert.equal(buy.amount,1200);assert.equal(buy.direction,'Buy');
 const sell=math.basketActionSizing({...base,currentWeight:.2,targetWeight:.1});assert.equal(sell.rawStocks,-2.5);assert.equal(sell.stocks,-3);assert.equal(sell.amount,-1200);
 const capped=math.basketActionSizing({...base,currentWeight:.9,targetWeight:.1,holdingQuantity:2.9});assert.equal(capped.stocks,-2);assert.equal(capped.sellCap,2);
 const zero=math.basketActionSizing({...base,currentWeight:.2,targetWeight:.2});assert.equal(zero.stocks,0);assert.equal(zero.amount,0);assert.equal(zero.direction,'Hold');
 assert.equal(math.basketActionSizing({...base,currentWeight:.200001,targetWeight:.2}).stocks,0);
 assert.deepEqual(base,{totalAssets:10000,currentWeight:.1,targetWeight:.2,upstoxLtp:400,holdingQuantity:5});
});

test('zero target sells all known holdings even without price; missing holdings are not invented',()=>{
 const base={totalAssets:10000,currentWeight:.5,targetWeight:0,upstoxLtp:null,holdingQuantity:5.5};
 const exit=math.basketActionSizing(base);assert.equal(exit.stocks,-5.5);assert.equal(exit.fullExit,true);assert.equal(exit.amount,null);
 assert.equal(math.basketActionSizing({...base,upstoxLtp:100}).amount,-550);
 assert.equal(math.basketActionSizing({...base,holdingQuantity:0}).stocks,0);
 assert.equal(math.basketActionSizing({...base,holdingQuantity:null,upstoxLtp:100}).stocks,null);
});

test('action sizing rejects missing, zero, invalid or overflowing inputs without price substitutes',()=>{
 const base={totalAssets:10000,currentWeight:.1,targetWeight:.2,upstoxLtp:100,holdingQuantity:5};
 for(const change of [{upstoxLtp:null},{upstoxLtp:0},{upstoxLtp:-1},{upstoxLtp:NaN},{totalAssets:null},{totalAssets:0},{currentWeight:null},{currentWeight:-1},{targetWeight:null},{targetWeight:20},{totalAssets:Number.MAX_VALUE,upstoxLtp:1e-300}])assert.equal(math.basketActionSizing({...base,...change}).stocks,null,JSON.stringify(change));
 assert.equal(math.basketActionSizing({...base,currentWeight:.5,holdingQuantity:null}).stocks,null);
 assert.equal(math.basketActionSizing({...base,currentWeight:.5,holdingQuantity:0}).stocks,0);
});

test('action columns are ordered before target columns and open reconciled Upstox-only stacked calculations',async()=>{
 for(const score of [1,-1]){
 const stock={symbol:'HAL',exchange:'NSE',action:'Trim',score,currentValue:500,holdingQuantity:5,holdingSource:'Kite exact venue',ltp:99,limitPrice:999,upstoxLtp:100,upstoxSource:'Upstox exact venue',upstoxAsOf:end};
 const h=hooks(),component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:async()=>history([observation(1,score)])},createPortal:node=>node});
 const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],1000,end,'Zerodha',{portfolioValue:500,availableMargin:500});};let state=render();h.flush();await tick();state=render();
 const header=React.Children.toArray(state.headers.props.children).flatMap(n=>n?.props?.children&&n.type===React.Fragment?React.Children.toArray(n.props.children):[n]).filter(n=>n?.type==='th').map(n=>n.props.children);assert.deepEqual(header.slice(-4),['Action Zerodha Stocks','Action Zerodha Amount','Target Zerodha Stocks','Target Zerodha Amount']);
 for(const kind of ['Action Zerodha Stocks','Action Zerodha Amount']){
 const button=find(state.cells(stock),node=>node.props?.['aria-label']===`HAL ${kind} calculation`);assert.ok(button);button.props.onClick();state=render();assert.equal(state.popup.props.title,kind);const calculation=state.popup.props.calculation;assert.equal(calculation.price,100);assert.ok(calculation.stocks<=0);assert.ok(calculation.stocks>=-5);assert.equal(calculation.amount,calculation.stocks*100);if(score<0){assert.equal(calculation.fullExit,true);assert.equal(calculation.stocks,-5);}
 state.popup.props.onClose();state=render();assert.equal(state.popup,null);
 }
 stock.upstoxSource='Kite';find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Action Zerodha Amount calculation').props.onClick();state=render();assert.equal(state.popup.props.calculation.amount,null);assert.equal(stock.ltp,99);assert.equal(stock.limitPrice,999);
 }
});

test('action popup explains fractions, sources, rounding and full exits using the shared accessible modal',()=>{
 const component=load('../components/BasketActionSizingPopup.tsx',{...math,BasketMetricPopup:()=>null});let closed=0;
 for(const target of [.2,0]){
 const calculation=math.basketActionSizing({totalAssets:1000,currentWeight:.5,targetWeight:target,upstoxLtp:100,holdingQuantity:5});
 const popup=component.BasketActionSizingPopup({title:'Action Zerodha Stocks',symbol:'HAL',exchange:'NSE',calculation,portfolioValue:500,availableMargin:500,snapshot:end,priceSource:'Upstox exact venue',priceAsOf:end,holdingSource:'Kite exact venue',onClose:()=>closed++});
 assert.equal(popup.props.wide,true);assert.match(popup.props.summary.value,/-/);const body=JSON.stringify(popup.props.children);assert.match(body,/fraction/);assert.match(body,/No Quoted LTP/);assert.match(body,/Orders unchanged/);assert.match(body,target===0?/without rounding/:/halves away from zero/);popup.props.onClose();
 }assert.equal(closed,2);
});

test('requested verbose basket notes are removed while selection and funding guards remain',()=>{
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
 for(const text of ['Protected MARKET requires backend direct-order access','Using latest synced portfolio snapshot prices until the first quote refresh','Refresh updates the preview and the next basket payload only','Includes safety buffer','rows stay selected only when Final Score'])assert.ok(!source.includes(text),text);
 assert.ok(source.includes('No affordable BUY rows remain after refreshed margin and safety buffer'));
 const display=readFileSync(new URL('../components/BasketDisplayCalculations.tsx',import.meta.url),'utf8');assert.ok(!display.includes('Current displayed Score:'));
});


test('compact quote time uses exact 24-hour IST presentation across date boundaries',()=>{
 const cases=[
  ['2026-10-30T10:28:33Z','30 Oct: 15:58:33 IST'],
  ['2026-10-30T15:58:33+05:30','30 Oct: 15:58:33 IST'],
  ['2026-10-30 10:28:33','30 Oct: 15:58:33 IST'],
  ['2026-10-31T18:29:59Z','31 Oct: 23:59:59 IST'],
  ['2026-10-31T18:30:00Z','1 Nov: 00:00:00 IST'],
  ['2026-12-31T18:30:00Z','1 Jan: 00:00:00 IST'],
  ['2028-02-28T18:30:00Z','29 Feb: 00:00:00 IST'],
 ];
 for(const [raw,expected] of cases)assert.equal(dateMath.formatCompactQuoteTime(raw),expected);
 for(const raw of [null,undefined,'','invalid'])assert.equal(dateMath.formatCompactQuoteTime(raw),'Unavailable');
});

test('integer amount presentation rounds signed halves away from zero without changing calculation precision',()=>{
 for(const [raw,expected] of [[243.5,'₹244'],[-243.5,'-₹244'],[-.4,'₹0'],[243.49,'₹243']])assert.equal(math.formatBasketIntegerCurrency(raw),expected);
 assert.equal(math.formatBasketIntegerCurrency(243.5,true),'+₹244');assert.equal(math.formatBasketIntegerCurrency(null),'Unavailable');
});

test('zero targets remain zero with holdings/missing price while Units share signed Action quantity and popup',async()=>{
 for(const score of [-1,1]){
 const stock={symbol:'HAL',exchange:'NSE',action:'Sell All',score,currentValue:500,holdingQuantity:5,ltp:null,limitPrice:null,upstoxLtp:score<0?null:100,upstoxAsOf:end,upstoxSource:'Upstox fixture'};
 const h=hooks(),component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:async()=>history([observation(1,score)])},createPortal:n=>n});const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],1000,end,'Zerodha');};let state=render();h.flush();await tick();state=render();
 if(score<0){for(const kind of ['Target Zerodha Stocks','Target Zerodha Amount']){const button=find(state.cells(stock),n=>n.props?.['aria-label']===`HAL ${kind} calculation`);assert.match(String(button.props.children),/0/);button.props.onClick();state=render();assert.match(state.popup.props.summary.value,/0/);assert.match(state.popup.props.summary.notice,/Zero Target/);state.popup.props.onClose();state=render();}assert.equal(state.metrics(stock).actionSizing.stocks,-5);}
 const action=find(state.cells(stock),n=>n.props?.['aria-label']==='HAL Action Zerodha Stocks calculation'),units=state.units(stock,'Units action');assert.equal(units.props.children,action.props.children);
 for(let i=0;i<3;i++){state.units(stock,'Units action').props.onClick();state=render();assert.equal(state.popup.props.title,'Action Zerodha Stocks');assert.equal(state.popup.props.calculation.stocks,state.metrics(stock).actionSizing.stocks);state.popup.props.onClose();state=render();assert.equal(state.popup,null);}
 }
});

test('Action New group identity is independent of original Side/action and mismatched executable drafts fail closed',()=>{
 assert.equal(math.basketActionGroup('Add More'),'Add more');assert.equal(math.basketActionGroup(null),'Unavailable');
 for(const [current,target,group]of[[500,0,'Sell All'],[500,.1,'Trim'],[0,.1,'Buy New'],[10,.1,'Add more'],[100,.1,'Hold']])assert.equal(math.basketActionGroup(math.weightComparison(current,1000,target).action),group);
 assert.equal(math.actionQuantityMatchesDraft(-5,'SELL',5),true);assert.equal(math.actionQuantityMatchesDraft(25,'BUY',25),true);for(const args of [[-5,'BUY',5],[25,'BUY',7],[null,'SELL',5],[0,'BUY',0],[-5,'SELL',2]])assert.equal(math.actionQuantityMatchesDraft(...args),false);
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/groupForDisplay\(row\) === action/);assert.match(source,/groupForOrder\(order\) === action/);assert.match(source,/Boolean\(orderSubmissionBlockedReason\) \|\| selectedDraftIssues.length > 0/);assert.match(source,/After sales: <strong>/);
});

test('reordered and renamed table uses stable IDs for every cell and preserves selection controls',()=>{
 const component=load('../components/BasketColumnPicker.tsx',{Children:React.Children,Fragment:React.Fragment,cloneElement:React.cloneElement,isValidElement:React.isValidElement,Menu:()=>null,BasketModalLayer:()=>null});let rename;
 const table=React.createElement('table',{},React.createElement('thead',{},React.createElement('tr',{},React.createElement('th',{'data-column-label':'Selection'},React.createElement('input',{type:'checkbox'})),React.createElement('th',{},'Units'))),React.createElement('tbody',{},React.createElement('tr',{},React.createElement('td',{},'selected'),React.createElement('td',{},'-5'))));
 const output=component.BasketColumnTable({children:table,hidden:[],order:['Units','Selection'],names:{Units:'Trade size',Selection:'Choose rows'},onOpen:()=>{},onRequestRename:id=>rename=id});const head=find(output,n=>n.type==='tr');const cells=React.Children.toArray(head.props.children);assert.equal(cells[0].props['data-basket-column'],'Units');assert.equal(cells[0].props.children,'Trade size');assert.ok(find(cells[1],n=>n.type==='input'));cells[0].props.onContextMenu({preventDefault(){}});assert.equal(rename,'Units');
});

test('editable Units use positive suggestions, whole steps and reactive genuine-price amounts',()=>{
 assert.equal(draftMath.suggestedDraftUnits(-13),13);assert.equal(draftMath.suggestedDraftUnits(25),25);assert.equal(draftMath.suggestedDraftUnits(null),null);
 assert.equal(draftMath.stepDraftUnits(13,1),14);assert.equal(draftMath.stepDraftUnits(0,-1),0);assert.equal(draftMath.stepDraftUnits(null,1),1);assert.equal(draftMath.stepDraftUnits(3.5,-1),3);assert.equal(draftMath.stepDraftUnits(3.5,1),4);
 assert.equal(draftMath.editableDraftAmount(5,4853.7),24268.5);assert.equal(draftMath.editableDraftAmount(25,1185),29625);assert.ok(Math.abs(draftMath.editableDraftAmount(6,4853.7)-29122.2)<1e-9);assert.equal(draftMath.editableDraftAmount(0,null),null);
 for(const action of ['Sell All','Trim','Sell'])assert.equal(draftMath.draftDirection(action),'SELL');for(const action of ['Buy New','Add More','Buy'])assert.equal(draftMath.draftDirection(action),'BUY');assert.equal(draftMath.draftDirection('Hold'),null);
});

test('selection stays independent but every invalid draft is rejected before the Market boundary',()=>{
 const now=Date.parse(end),base={units:5,price:100,currentUnits:5,exchange:'NSE',draftContext:{action:'Sell All',suggestedUnits:5,source:'Upstox fixture',asOf:end}};
 assert.deepEqual(draftMath.editableDraftIssues(base,now),[]);
 for(const patch of [{units:0},{units:null},{units:1.5},{units:-1},{units:6},{price:null},{price:0},{exchange:'NYSE'},{currentUnits:null},{draftContext:{...base.draftContext,asOf:start}},{draftContext:{...base.draftContext,source:'Kite'}},{draftContext:{...base.draftContext,action:'Hold'}}])assert.ok(draftMath.editableDraftIssues({...base,...patch},now).length,JSON.stringify(patch));
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');const handler=source.slice(source.indexOf('const placeSelectedZerodhaBasketOrders ='),source.indexOf('const placeSelectedZerodhaBasketOrders =')+3200);assert.match(handler,/missingIds/);assert.match(handler,/editableDraftIssues/);assert.match(handler,/Market drafts require direct broker access/);assert.match(handler,/assertWholeShareOrdersReviewed/);assert.doesNotMatch(handler,/\.filter\(isWholeShareOrderSelectable\)/);
 const view=source.slice(source.indexOf('function ScopedZerodhaBasketPreviewDialog'),source.indexOf('function IndMoneySnapshotDialog'));assert.doesNotMatch(view,/>Buy Threshold<|Display Stocks \(Score range\)|visible selectable selected/);assert.match(view,/const visibleScore = \(_score: number \| null\) => true/);assert.match(view,/onPlaceOrder\(isZerodhaPreview \? basketRows/);assert.match(view,/Market<\/span>/);
});

test('draft Units popup distinguishes suggested calculation from manual positive edits',async()=>{
 const stock={symbol:'HAL',exchange:'NSE',action:'Sell All',score:-1,currentValue:500,holdingQuantity:5,ltp:null,upstoxLtp:100,upstoxAsOf:end,upstoxSource:'Upstox fixture'};
 const h=hooks(),component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:async()=>history([observation(1,-1)])},createPortal:n=>n});const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],1000,end,'Zerodha');};let state=render();h.flush();await tick();state=render();
 for(let i=0;i<3;i++){const button=state.units(stock,'Units action',4);assert.equal(button.props.children,'4');assert.doesNotMatch(button.props.className,/underline|dotted/);button.props.onClick();state=render();assert.equal(state.popup.props.draftUnits,4);assert.equal(state.popup.props.calculation.stocks,-5);state.popup.props.onClose();state=render();}
 assert.equal(state.controls,null);assert.equal(state.showAll,true);
});

test('real submission handler rejects every invalid selection and reviews edited draft quantity without sending orders',async()=>{
 let error='',reviewed=null,confirms=0;const selected=new Set(['HAL','ONGC']);
 const send=callback('placeSelectedZerodhaBasketOrders',{useCallback:fn=>fn,zerodhaOrderSubmissionBlockedReason:null,selectedZerodhaBasketIds:selected,zerodhaBasketOrders:[],zerodhaBasketSubmission:null,zerodhaExecutionMode:'direct_market',setZerodhaBasketError:value=>error=value,editableDraftIssues:draftMath.editableDraftIssues,stockIdentity:math.stockIdentity,compareZerodhaBasketOrdersByScore:()=>0,assertWholeShareOrdersReviewed:()=>{},getIndiaMarketStatus:()=>({open:true,label:'offline market fixture'}),chunkZerodhaBasketOrders:orders=>{reviewed=orders;return[orders];},window:{alert(){},confirm(){confirms++;return false;}},apiService:new Proxy({},{get(){throw new Error('Provider/order operation forbidden in offline test');}})});
 const context={action:'Sell All',suggestedUnits:5,source:'Upstox fixture',asOf:new Date().toISOString()};const rows=[{id:'HAL',symbol:'HAL',exchange:'NSE',units:0,currentUnits:5,price:100,side:'SELL',draftContext:context},{id:'ONGC',symbol:'ONGC',exchange:'NSE',units:3,currentUnits:3,price:null,side:'SELL',draftContext:context}];
 await send(rows);assert.match(error,/HAL/);assert.match(error,/ONGC/);assert.equal(confirms,0);assert.equal(selected.size,2);
 await send(rows.slice(0,1));assert.match(error,/missing.*ONGC/);
 error='';const valid=rows.map(row=>({...row,units:row.id==='HAL'?4:2,price:100}));await send(valid);assert.equal(error,'');assert.equal(confirms,1);assert.equal(reviewed[0].units,4);assert.equal(reviewed[1].units,2);assert.equal(selected.size,2);
});
