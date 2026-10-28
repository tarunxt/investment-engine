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
 useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useMemo(fn){cursor++;return fn();},
 useEffect(fn,deps){const i=cursor++,prior=slots[i];if(!prior||deps.some((d,n)=>d!==prior.deps[n])){effects.push(()=>{prior?.cleanup?.();slots[i]={deps,cleanup:fn()};});}}
 }};
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;return React.Children.toArray(node.props?.children).map(n=>find(n,predicate)).find(Boolean)??null;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('delayed history, day/scope changes, stale responses and nested calculation dismissal preserve parent state',async()=>{
 const h=hooks(),pending=[];let restored=0;const document={body:{},activeElement:{focus(){restored++;}}};
 const component=load('../components/BasketDisplayCalculations.tsx',{...h.bindings,...math,apiService:{getBasketScoreHistory:params=>new Promise((resolve,reject)=>pending.push({params,resolve,reject}))},createPortal:n=>n,document});
 const stocks=[{symbol:'HAL',exchange:'NSE',score:2.5,ltp:243}], render=(open=true,market='india',scope=stocks)=>{h.start();return component.useBasketDisplayCalculations(open,market,scope,67545,end,'Zerodha');};
 let state=render();assert.equal(state.loading,true);h.flush();assert.equal(pending.length,1);pending.shift().resolve(history([observation(1,2)]));await tick();state=render();assert.equal(state.loading,false);
 const historyButton=find(state.cells(stocks[0]),n=>n.props?.['aria-label']==='HAL Historical Weighted Score calculation');historyButton.props.onClick();state=render();assert.equal(state.popupOpen,true);
 const popup=state.popup.type(state.popup.props);assert.equal(popup.props.role,'dialog');h.flush();let stopped=0;popup.props.onClick({stopPropagation(){stopped++;}});state=render();assert.equal(state.popupOpen,false);assert.equal(stopped,1);
 state.setParameters({...state.parameters,days:10});state=render();h.flush();const old=pending.shift();assert.equal(old.params.days,10);
 render(true,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);h.flush();old.resolve({...history([observation(2,99)]),days:10});await tick();state=render(true,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);assert.equal(state.loading,true);
 const current=pending.shift();current.resolve({...history([]),market:'us',days:10});await tick();state=render(true,'us',[{symbol:'HAL',exchange:'NYSE',score:2,ltp:243}]);assert.equal(state.loading,false);
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
