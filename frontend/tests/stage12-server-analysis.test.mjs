import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const path='../app/console/automated-rebalance/_components/ServerAnalysis.tsx';
function load(imports,timer=()=>0){const out={};const js=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','exports','setTimeout','clearTimeout',js)(name=>imports[name],out,timer,()=>{});return out;}
const jsx=(type,props,key)=>({type,props,key});
const nodes=tree=>tree==null||typeof tree==='boolean'?[]:Array.isArray(tree)?tree.flatMap(nodes):typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
function harness({enabled=true,items=[],error=null,portfolioScope=undefined,responseOwner=1}={}){
  let slots=[],index=0,effects=[],cleanup=[],tree,gets=[],posts=[],release,session={user:{id:'1'},generation:'a'};
  const react={useState(init){const i=index++;if(!(i in slots))slots[i]=init;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},useRef(init){const i=index++;if(!(i in slots))slots[i]={current:init};return slots[i];},useEffect(fn){index++;if(!cleanup.length)effects.push(fn);}};
  const api={async get(url){gets.push(url);if(error)throw new Error(error);return url.endsWith('/config')?{enabled}:{owner_id:responseOwner,items};},post(url,body){posts.push({url,body});return new Promise(resolve=>{release=resolve;});}};
  const ui=load({react,'next-auth/react':{useSession:()=>({status:'authenticated',data:session})},'@/services/api':{apiService:api},'@/lib/urls':{URLs:{runs:{list:()=>'/runs'}}},'react/jsx-runtime':{jsx,jsxs:jsx}});
  function render(){index=0;tree=ui.ServerAnalysisSession({portfolioScope});}
  async function flush(){for(let i=0;i<8;i++)await Promise.resolve();render();}
  render();cleanup=effects.map(fn=>fn());
  return {flush,gets,posts,find:label=>nodes(tree).find(n=>n.type==='button'&&n.props.children===label),tree:()=>tree,release:row=>release(row),unmount:()=>cleanup.forEach(fn=>fn?.())};
}
const row=(status='processing')=>({id:3,owner_id:1,portfolio:'indmoney_us',status,stage:'sync',version:4,error:null,inputs:{source_hash:'source-v1',plan_hash:'plan-v1',orders_authorized:false},stages:[{stage:'sync',status,attempts:1,checkpoint:{attempts:[{cost_usd:'0'}]},error:null}]});
test('disabled runtime cannot start work and never submits on mount',async()=>{const h=harness({enabled:false});await h.flush();assert.equal(h.find('Start server analysis'),undefined);assert.equal(h.posts.length,0);assert.match(JSON.stringify(h.tree()),/unavailable/);h.unmount();});
test('enabled observer only reads; persisted completion never launches next browser stage',async()=>{const h=harness({items:[row('completed')]});await h.flush();assert.equal(h.posts.length,0);assert.deepEqual(h.gets,['/runs/analysis-workflows/config','/runs/analysis-workflows']);assert.equal(h.find('retry'),undefined);assert.match(JSON.stringify(h.tree()),/completed/);h.unmount();});
test('double start submits one request until the server returns',async()=>{const h=harness();await h.flush();const button=h.find('Start server analysis');const first=button.props.onClick();button.props.onClick();assert.equal(h.posts.length,1);assert.equal(h.posts[0].body.portfolio,'indmoney_us');assert.ok(h.posts[0].body.key);h.release(row());await first;await h.flush();assert.match(JSON.stringify(h.tree()),/Workflow/);h.unmount();});
test('pause uses authoritative server workflow and CAS version',async()=>{const h=harness({items:[row()]});await h.flush();h.find('pause').props.onClick();assert.deepEqual(h.posts[0],{url:'/runs/analysis-workflows/3/controls',body:{portfolio:'indmoney_us',version:4,action:'pause'}});h.release(row('paused'));await h.flush();h.unmount();});
test('unmount invalidates a pending control response',async()=>{const h=harness({items:[row()]});await h.flush();h.find('pause').props.onClick();h.unmount();h.release(row('paused'));await h.flush();assert.match(JSON.stringify(h.tree()),/processing/);});
test('status outage exposes error without inventing data or starting fallback work',async()=>{const h=harness({error:'Synthetic outage'});await h.flush();assert.equal(h.posts.length,0);assert.match(JSON.stringify(h.tree()),/Synthetic outage/);assert.equal(h.find('Start server analysis'),undefined);h.unmount();});
test('owner and same-owner session changes replace private component lifetime',()=>{let id='1',generation='a',status='authenticated';const ui=load({'next-auth/react':{useSession:()=>({status,data:{user:{id},generation}})},'react/jsx-runtime':{jsx,jsxs:jsx}});assert.equal(ui.ServerAnalysis().key,'1:a:all');id='2';assert.equal(ui.ServerAnalysis().key,'2:a:all');generation='b';assert.equal(ui.ServerAnalysis().key,'2:b:all');status='unauthenticated';assert.equal(ui.ServerAnalysis().type,'p');});

test('scoped module observes only its selected portfolio and binds deliberate start',async()=>{const h=harness({portfolioScope:'india'});await h.flush();assert.deepEqual(h.gets,['/runs/analysis-workflows/config','/runs/analysis-workflows?selected_only=true&portfolio=india']);assert.equal(nodes(h.tree()).some(n=>n.type==='select'),false);const first=h.find('Start server analysis').props.onClick();assert.equal(h.posts[0].body.portfolio,'india');h.release({...row(),portfolio:'india'});await first;h.unmount();});
test('foreign-owner list is rejected before showing another account run',async()=>{const h=harness({items:[row()],responseOwner:2});await h.flush();assert.match(JSON.stringify(h.tree()),/Invalid owned module analysis/);assert.doesNotMatch(JSON.stringify(h.tree()),/Workflow 3/);h.unmount();});
