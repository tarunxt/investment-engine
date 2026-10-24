import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const jsx=(type,props,key)=>({type,props,key});
function harness(file,component,value,{pending=false,fail=false}={}){
 let slots=[],index=0,effects=[],deps=[],cleanup=[],tree,calls=[];
 const react={useState(v){const i=index++;if(!(i in slots))slots[i]=v;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef(v){const i=index++;if(!(i in slots))slots[i]={current:v};return slots[i];},useEffect(fn,d){const i=index++;if(!deps[i]||d.some((v,j)=>v!==deps[i][j])){deps[i]=d;effects.push(()=>{cleanup[i]?.();cleanup[i]=fn();});}}};
 const api={fetch(url,options){calls.push({url,options});return pending?new Promise(()=>{}):fail?Promise.reject(new Error('synthetic read timeout')):Promise.resolve(value);}};
 const imports={react,'react/jsx-runtime':{jsx,jsxs:jsx},'next-auth/react':{useSession:()=>({status:'authenticated',data:{user:{id:'1'},generation:'synthetic'}})},'@/services/api':{apiService:api}};
 const source=readFileSync(new URL(file,import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;const ui={};new Function('require','exports',code)(n=>imports[n],ui);
 function render(){index=0;if(component==='SimulationDiagnostics'){const view=ui[component]();tree=view.type(view.props);}else tree=ui[component]({owner:1});while(effects.length)effects.shift()();}
 return{calls,tree:()=>tree,render,async flush(){render();for(let i=0;i<10;i++)await Promise.resolve();render();},recover(next){pending=false;fail=false;value=next;},unmount(){cleanup.forEach(c=>c?.());}};
}
const diagnostics=()=>({owner_id:1,stale_data:false,unknown_orders:false,cost_spike:false,source_unavailable:false,external_delivery:false,simulation_only:true,correlation_id:'synthetic-reference',observed_at:'2026-10-24T07:15:00Z'});
const emptyOrders={schema_version:1,owner_id:1,runtime_enabled:true,simulation_only:true,observed_at:'2026-10-24T07:15:00Z',has_more:false,complete_positions_reconciliation:false,intents:[]};
const diag=(v=diagnostics())=>harness('../components/uat2/SimulationDiagnostics.tsx','SimulationDiagnostics',v);
const orders=options=>harness('../components/modules/OrderReviews.tsx','OrderReviewsSession',null,options);
const text=h=>JSON.stringify(h.tree());
const nodes=t=>t==null||typeof t==='boolean'?[]:Array.isArray(t)?t.flatMap(nodes):typeof t==='object'?[t,...nodes(t.props?.children)]:[];
for(const state of ['unavailable','loading'])test(`quiet monitor never clears ${state} order-history state`,async()=>{
 const d=diag(),o=orders(state==='unavailable'?{fail:true}:{pending:true});await d.flush();await o.flush();
 assert.match(text(o),state==='unavailable'?/Order status unavailable/:/Loading private order records/);
 assert.doesNotMatch(text(d),/No unresolved order state|safe to resubmit|No orders/);
 assert.match(text(d),/does not establish whether orders are unresolved/);
 assert.ok([...d.calls,...o.calls].every(c=>!c.options.method));d.unmount();o.unmount();
});
test('recovered empty history preserves broker disclaimer and neutral diagnostics',async()=>{
 const d=diag(),o=orders({fail:true});await d.flush();await o.flush();assert.match(text(o),/Order status unavailable/);
 o.recover(emptyOrders);nodes(o.tree()).find(n=>n.type==='button'&&n.props.children==='Refresh recorded order status').props.onClick();await o.flush();
 assert.match(text(o),/No persisted order intents/);assert.match(text(o),/does not establish that your broker/);
 assert.doesNotMatch(text(d),/No unresolved order state/);assert.match(text(d),/does not establish whether orders are unresolved/);d.unmount();o.unmount();
});
test('affirmative unresolved observation still warns against resubmission',async()=>{const d=diag({...diagnostics(),unknown_orders:true});await d.flush();assert.match(text(d),/Unresolved execution needs reconciliation; do not resubmit/);d.unmount();});
test('foreign observations fail closed',async()=>{const d=diag({...diagnostics(),owner_id:2,correlation_id:'FOREIGN'});await d.flush();assert.match(text(d),/Recovery observations unavailable/);assert.doesNotMatch(text(d),/FOREIGN/);d.unmount();});
