import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {harness,nodes} from './helpers/workspace-hooks.mjs';
const costs={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/conceptFCostReceipts.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(costs);
const row=(id,module_id='zerodha_rebalance')=>({id,module_id,module_version:2,status:'completed',created_at:'2026-10-25T01:00:00Z',updated_at:'2026-10-25T02:00:00Z'});
const page=(number,items,total=21)=>({items,total,page:number,limit:20,size:20,pages:Math.max(1,Math.ceil(total/20))});
function setup(portfolio='india'){const changes=[];const h=harness(new URL('../components/workspace/ConceptFSetupSourceCatalogue.tsx',import.meta.url),'ConceptFSetupSourceCatalogue',{portfolio,onChange:value=>changes.push(value)},{Link:'a',recordedCostTimestamp:costs.recordedCostTimestamp});return Object.assign(h,{changes});}
const button=(h,name)=>nodes(h.tree()).find(n=>n.type==='button'&&n.props['aria-label']===name);
async function first(h){h.button('Expand owned module source records').props.onClick();h.requests[0].resolve(page(1,Array.from({length:20},(_,i)=>row(100-i))));await h.flush();}
test('F45 explicit older page stays scoped and clears exact assignments without writes',async()=>{
 const h=setup();assert.equal(h.requests.length,0);await first(h);
 const oldAssignment=nodes(h.tree()).find(n=>n.props?.['aria-label']==='Assign run 100 as swing input').props.onChange;oldAssignment({target:{checked:true}});await h.flush();assert.equal(h.changes.at(-1)[0].run_id,100);
 assert.equal(button(h,'Previous source page').props.disabled,true);button(h,'Next source page').props.onClick();await h.flush();assert.deepEqual(h.changes.at(-1),[]);assert.doesNotMatch(h.text(),/Run 100/);assert.match(h.requests[1].url,/selected_only=true&module_id=zerodha_rebalance&limit=20&page=2/);
 h.requests[1].resolve(page(2,[row(80)]));await h.flush();assert.match(h.text(),/Page 2 of 2/);oldAssignment({target:{checked:true}});assert.deepEqual(h.changes.at(-1),[]);assert.equal(button(h,'Next source page').props.disabled,true);assert.equal(button(h,'Previous source page').props.disabled,false);assert.equal(nodes(h.tree()).find(n=>n.props?.['aria-label']==='Assign run 80 as swing input').props.checked,false);
 button(h,'Previous source page').props.onClick();assert.match(h.requests[2].url,/page=1$/);assert.ok(h.requests.every(r=>!r.options.method));h.cleanup();
});
test('F45 changed or absent totals and wrong page metadata never show misleading older sources',async()=>{
 for(const bad of [{items:[row(80)]},page(2,[row(80)],10),page(2,[],21),{...page(2,[row(80)]),page:1},{...page(2,[row(80)]),pages:99},{...page(2,[row(80)]),limit:100}]){
  const h=setup();await first(h);button(h,'Next source page').props.onClick();h.requests[1].resolve(bad);await h.flush();assert.doesNotMatch(h.text(),/Run 80/);assert.match(h.text(),/catalogue unavailable|changed/);assert.deepEqual(h.changes.at(-1),[]);h.cleanup();
 }
});
test('F45 same-page duplicate clicks issue one read and unmount rejects late older-page evidence',async()=>{
 const h=setup();await first(h);const next=button(h,'Next source page');next.props.onClick();next.props.onClick();assert.equal(h.requests.length,2);h.cleanup();assert.equal(h.requests[1].options.signal.aborted,true);h.requests[1].resolve(page(2,[row(80)]));await h.flush();assert.doesNotMatch(h.text(),/Run 80/);assert.deepEqual(h.changes.at(-1),[]);
});
test('F45 changed valid totals update navigation without implying complete historical coverage',async()=>{
 const h=setup();await first(h);button(h,'Next source page').props.onClick();h.requests[1].resolve(page(2,[row(80)],41));await h.flush();assert.match(h.text(),/Page 2 of 3/);assert.equal(button(h,'Next source page').props.disabled,false);assert.match(h.text(),/not a complete history/);assert.match(h.text(),/change between page reads/);h.cleanup();
});
test('F45 genuine empty first page is admitted with disabled navigation, not a global history claim',async()=>{
 const h=setup();h.button('Expand owned module source records').props.onClick();h.requests[0].resolve(page(1,[],0));await h.flush();assert.match(h.text(),/Page 1 of 1/);assert.match(h.text(),/No module-bound sources returned/);assert.doesNotMatch(h.text(),/catalogue unavailable/);assert.equal(button(h,'Previous source page').props.disabled,true);assert.equal(button(h,'Next source page').props.disabled,true);assert.equal(nodes(h.tree()).some(n=>n.type==='input'),false);h.cleanup();
});
