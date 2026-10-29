import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as React from 'react';
const require = createRequire(import.meta.url);
function load(path, bindings={}) { const source=readFileSync(new URL(path,import.meta.url),'utf8'), ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX); const text=ast.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(ast)).join('\n'); const output=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText; const result={exports:{}}; new Function('exports','module','require',...Object.keys(bindings),output)(result.exports,result,require,...Object.values(bindings));return result.exports; }
const math=load('../lib/basketDisplayCalculations.ts');
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
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/lg:grid-cols-5/);assert.match(source,/displayOnlyRows/);assert.match(source,/No executable order/);assert.match(source,/useBasketDisplayCalculations/);
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
 const popup=state.popup.type(state.popup.props);assert.equal(popup.props.role,'dialog');h.flush();let stopped=0;popup.props.onClick({stopPropagation(){stopped++;}});state=render();assert.equal(state.popupOpen,false);assert.equal(stopped,1);
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
 h.start();const popup=CalculationPopup({title:'HAL ZerodhaStocks',children:'actual inputs',onClose(){closed++;}});const panel={focus(){focused++;},querySelectorAll(){return[first,last];}};popup.props.ref.current=panel;h.flush();assert.equal(focused,1);
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
  selected=new Set(['B']);fn('Buy New',['A','locked','display-only','other']);assert.deepEqual([...selected].sort(),['A','B']);
  fn('Buy New',[]);assert.deepEqual([...selected].sort(),['A','B']);
  const all=callback(`toggleAll${cap}BasketOrders`,{useCallback:fn=>fn,[`${broker}BasketOrders`]:orders.filter(o=>o.selectable),[`setSelected${cap}BasketIds`]:fn=>{selected=fn(selected);},isWholeShareOrderSelectable:row=>row.selectable});
  all();assert.deepEqual([...selected].sort(),['A','B','other']);all();assert.equal(selected.size,0);
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
 const bindings={validDisplayPrice:math.validDisplayPrice,useBasketDisplayQuotes:()=>({quotes:[],loading:false}),verifiedFetchedDisplayQuote:()=>null,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useBasketDisplayCalculations:()=>({popupOpen:false,showAll:true,lower:-2,upper:1.5,cells:()=>Array.from({length:4},(_,i)=>React.createElement("td",{key:i},"derived")),headers:null,controls:null,popup:null,setParameters:()=>{}}),portfolioParameterMargin:()=>0,portfolioParameterAssets:()=>({portfolioValue:100,availableMargin:0,totalAssets:100}),verifiedDisplayQuote:()=>null,displayScoreAccepted:()=>true,isWholeShareOrderSelectable:()=>true,getZerodhaAvailableMarginToneClass:()=>'',getIndiaMarketStatus:()=>({open:false,label:'NSE/BSE closed → Zerodha AMO'}),ZERODHA_BASKET_SECTION_ORDER:['Buy New'],ZERODHA_BASKET_SECTION_LABELS:{'Buy New':'Buy New'},getZerodhaBasketActionForPercent:order=>order.action,compareZerodhaBasketOrdersByScore:()=>0,parseTimestampMs:Date.parse,formatTimestamp:v=>v,formatBasketCurrency:(value,currency)=>`${currency} ${value}`,formatZerodhaLtpRefreshTime:()=>'',formatBasketQuantity:String,formatBasketPercent:String,getZerodhaBasketUnitLimit:()=>null,ZERODHA_ORDER_KINDS:['Market'],Fragment:React.Fragment,Button,cn:(...v)=>v.filter(Boolean).join(' '),Info:stub,X:stub,Loader2:stub,TradingViewUrlListButton:stub,TradingViewSymbolLink:props=>React.createElement('span',null,props.children),PortfolioParametersTile:stub,ScoreMatrixModal:stub,StockDetailsButton:stub,ScoreMatrixButton:stub,ConsensusBreakupButton:stub,WholeShareTrimChoice:stub};
 const result={exports:{}};new Function('exports','module','require',...Object.keys(bindings),output)(result.exports,result,require,...Object.values(bindings));
 const props={open:true,loading:false,error:null,orders:[{id:'row',symbol:'ABC',exchange:'NASDAQ',action:'Buy New',side:'BUY',units:1,lastPrice:20,price:20,amount:20,percent:100,orderKind:'Market',stock:{},detail:{calculatedScore:2}}],selectedIds:new Set(),detailsData:{portfolioSnapshot:null},historicalRows:[],formulaConfig:{},buyThreshold:2.5,buyThresholdDraft:'2.50',onBuyThresholdDraftChange:()=>{},onClose:()=>{},onToggle:()=>{},onToggleAll:()=>{},onToggleSection:()=>{},onUnitsChange:()=>{},onPercentChange:()=>{},onOrderKindChange:()=>{},onExecutionModeChange:()=>{},onRefreshLtp:()=>{},onFormulaConfigChange:()=>{},executionMode:'publisher_limit',placing:false,directMarketAvailable:false,submission:null,ltpRefreshing:false,ltpRefreshedAt:null};
 let executions=0;const onPlaceOrder=()=>{executions++;};
 const us=result.exports.ScopedZerodhaBasketPreviewDialog({...props,tradingViewMarket:'us',basketBrokerLabel:'IndMoney',basketTitle:'IndMoney Final Order Basket',previewLabel:'IndMoney Basket Preview',primaryButtonLabel:'Final Order',basketCurrency:'USD',onPlaceOrder});
 const {renderToStaticMarkup}=require('react-dom/server');const html=renderToStaticMarkup(us);
 assert.doesNotMatch(html,/Zerodha|NSE\/BSE|AMO|Kite|Protected LIMIT|Execution Mode|Refresh LTP/);
 assert.match(html,/IndMoney US basket review/);assert.match(html,/Select or deselect Buy New IndMoney basket orders/);assert.match(html,/USD/);assert.equal(executions,0);
 const button=find(us,n=>n.type===Button&&n.props.onClick===onPlaceOrder);assert.ok(button);assert.equal(button.props.onClick,onPlaceOrder);
 const india=result.exports.ScopedZerodhaBasketPreviewDialog({...props,tradingViewMarket:'india',basketBrokerLabel:'Zerodha',onPlaceOrder});
 const indiaHtml=renderToStaticMarkup(india);assert.match(indiaHtml,/NSE\/BSE closed/);assert.match(indiaHtml,/Kite/);assert.match(indiaHtml,/Protected LIMIT/);assert.equal(executions,0);
 bindings.ZERODHA_BASKET_SECTION_ORDER.push('Sell All','Trim','Add more');
 const actions=['Sell All','Trim','Buy New','Add more','Hold'];
 const allocationUniverse=actions.map((action,index)=>({id:`display-${index}`,formulaAction:action,formulaScore:index/10,stock:{key:`NSE:FIXTURE${index}`,symbol:`FIXTURE${index}`,exchange:'NSE',rows:[]},detail:{calculatedScore:index/10}}));
 const display=result.exports.ScopedZerodhaBasketPreviewDialog({...props,orders:[],allocationUniverse,tradingViewMarket:'india',basketBrokerLabel:'Zerodha',onPlaceOrder});
 const displayRows=[];function collect(node){if(!node||typeof node!=='object')return;if(node.props?.['data-display-only'])displayRows.push(node);React.Children.toArray(node.props?.children).forEach(collect);}collect(display);
 assert.equal(displayRows.length,5);for(const row of displayRows){assert.equal(React.Children.toArray(row.props.children).length,17);assert.equal(find(row,node=>node.type==='input').props.disabled,true);assert.equal(find(row,node=>node.type==='input').props.onChange,undefined);assert.equal(find(row,node=>node.type==='select'),null);}
 const displayHtml=renderToStaticMarkup(display);for(const action of actions)assert.ok(displayHtml.includes(action));assert.equal((displayHtml.match(/colSpan="17"/g)??[]).length,5);assert.match(displayHtml,/Hold · No executable order/);assert.match(displayHtml,/Unavailable/);assert.match(displayHtml,/Not applicable/);assert.equal(executions,0);

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
 const amount=find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Zerodha Amount calculation');assert.equal(amount.props.title,'Estimate using Limit Price; not live LTP');assert.match(JSON.stringify(amount.props.children),/80.00/);assert.doesNotMatch(JSON.stringify(amount.props.children),/Estimate/);amount.props.onClick();state=render();let text=JSON.stringify(state.popup.props.children);assert.match(text,/Estimate using Limit Price; not live LTP/);assert.match(text,/Used price/);assert.equal(stock.ltp,null);assert.equal(stock.limitPrice,40);
 const quoted={...stock,ltp:50,quoteLoading:false};state=render(true,[quoted]);text=JSON.stringify(state.popup.props.children);assert.doesNotMatch(text,/Estimate using Limit Price; not live LTP/);assert.equal(find(state.cells(quoted),node=>node.props?.['aria-label']==='HAL Zerodha Amount calculation').props.children,'₹100.00');
 render(false);h.flush();state=render(true,[{...stock,limitPrice:null,quoteLoading:false}]);h.flush();assert.equal(state.loading,true);pending.shift().resolve(history([observation(2,2)]));await tick();state=render(true,[{...stock,limitPrice:null,quoteLoading:false}]);assert.equal(find(state.cells({...stock,limitPrice:null,quoteLoading:false}),node=>node.props?.['aria-label']==='HAL Zerodha Amount calculation').props.children,'Unavailable');
 const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');assert.match(source,/limitPrice: tradingViewMarket === "india" \? validDisplayPrice\(order\?\.price\)/);assert.doesNotMatch(source,/ltp:\s*validDisplayPrice\(order\?\.price/);
});

 test('popup final currency results use shared rounding while retaining precise intermediates',async()=>{
 const h=hooks(),pending=[];const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:()=>new Promise(resolve=>pending.push(resolve))},createPortal:node=>node});
 const stock={symbol:'HAL',exchange:'NSE',score:2,ltp:1374.3};
 const render=()=>{h.start();return component.useBasketDisplayCalculations(true,'india',[stock],190000,end,'Zerodha');};
 let state=render();h.flush();pending.shift()(history([observation(1,2)]));await tick();state=render();
 find(state.cells(stock),node=>node.props?.['aria-label']==='HAL Zerodha Amount calculation').props.onClick();state=render();
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
