import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/console/_components/RunDetailPageContent.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('run.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='RunDetailPage');
const body=fn.body.getText(ast),cut=body.indexOf('\n  if (!hasValidRunId) {');
assert.ok(cut>0);
const js=ts.transpileModule('function Page() '+body.slice(0,cut)+'\nreturn {run,loading,error,scope,readScope,loadRun};}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function setup(uat2=true){
 let id='12',session={data:{user:{id:1},generation:1},status:'authenticated'},slots=[],effects=[],layouts=[],queued=new Map(),layoutQueue=new Map(),index=0,rendering=false,view,renderWrites=0,alive=true,lateWrites=0;
 const requests=[],redirects=[],router={replace:value=>redirects.push(value)};
 const state=initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{if(!alive)lateWrites++;slots[i]=typeof value==='function'?value(slots[i]):value;}];};
 const ref=initial=>{const i=index++;if(!(i in slots)){let value=initial;slots[i]={get current(){return value;},set current(next){if(rendering)renderWrites++;value=next;}};}return slots[i];};
 const effect=(store,queue)=>(run,deps)=>{const i=index++;if(!store[i]||deps.some((v,j)=>!Object.is(v,store[i].deps[j])))queue.set(i,()=>{store[i]?.cleanup?.();store[i]={deps,run,cleanup:run()};});};
 const callback=(fn,deps)=>{const i=index++;if(!slots[i]||deps.some((v,j)=>!Object.is(v,slots[i].deps[j])))slots[i]={deps,value:fn};return slots[i].value;};
 const values={useParams:()=>({id}),useRouter:()=>router,usePathname:()=>'/console/runs/'+id,useSession:()=>session,useWorkspaceDisplay:()=>null,process:{env:{NEXT_PUBLIC_UAT2:String(uat2)}},useState:state,useRef:ref,useCallback:callback,useEffect:effect(effects,queued),useLayoutEffect:effect(layouts,layoutQueue),WSClient:class{connect(){}close(){}},apiService:{getRun:id=>new Promise((resolve,reject)=>requests.push({url:'/runs/'+id,options:{},resolve,reject})),getApiUsageSummary:()=>Promise.resolve({fx_status:'unknown'}),get:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))},URLs:{runs:{get:id=>'/runs/'+id,wsRun:id=>'/ws/'+id}},admitRecordedRun:(row,id)=>{if(row.id!==id)throw Error('wrong identity');return row;},getRunDetailPathFromPrompt:id=>'/console/runs/'+id,isRunDetailPath:()=>true,normalizeError:e=>e.message};
 const Page=new Function(...Object.keys(values),js+';return Page;')(...Object.values(values));
 function render(){index=0;rendering=true;try{view=Page();}finally{rendering=false;}}
 function layout(){const tasks=[...layoutQueue.values()];layoutQueue.clear();tasks.forEach(f=>f());}function passive(){const tasks=[...queued.values()];queued.clear();tasks.forEach(f=>f());}
 render();layout();passive();
 return{requests,redirects,get view(){return view;},get renderWrites(){return renderWrites;},get lateWrites(){return lateWrites;},render,layout,passive,strictReplay(){layouts.forEach(e=>e?.cleanup?.());effects.forEach(e=>e?.cleanup?.());layouts.forEach(e=>{if(e)e.cleanup=e.run();});effects.forEach(e=>{if(e)e.cleanup=e.run();});},navigate(next){id=next;render();},session(next){session=next;render();},async settle(){for(let i=0;i<10;i++)await Promise.resolve();render();},cleanup(){layouts.forEach(e=>e?.cleanup?.());effects.forEach(e=>e?.cleanup?.());alive=false;}};
}
test('recorded run scope is never mutated during render',()=>{const h=setup();h.navigate('13');assert.equal(h.renderWrites,0);h.cleanup();});
test('committed route change aborts old read before passive effects and refuses stale refresh callbacks',async()=>{
 const h=setup(),oldRefresh=h.view.loadRun;h.navigate('13');assert.notEqual(h.view.readScope,h.view.scope);h.layout();assert.equal(h.requests[0].options.signal.aborted,true);await oldRefresh();assert.equal(h.requests.length,1);h.requests[0].resolve({id:12,prompt:'old'});await h.settle();assert.equal(h.view.run,null);assert.equal(h.redirects.length,0);h.passive();h.requests.at(-1).resolve({id:13,prompt:'current'});await h.settle();assert.equal(h.view.run.id,13);assert.equal(h.view.readScope,h.view.scope);h.cleanup();
});
for(const changed of [{data:{user:{id:2},generation:1},status:'authenticated'},{data:{user:{id:1},generation:2},status:'authenticated'},{data:null,status:'unauthenticated'}])test('owner/session change rejects late previous identity reads '+JSON.stringify(changed),async()=>{
 const h=setup();h.session(changed);h.layout();h.requests[0].resolve({id:12,prompt:'old-owner'});await h.settle();assert.equal(h.view.run,null);assert.notEqual(h.view.readScope,h.view.scope);h.passive();assert.equal(h.requests.length,changed.status==='authenticated'?2:1);h.cleanup();
});
test('unmount prevents late success/error writes and canonical redirects',async()=>{for(const fail of [false,true]){const h=setup();h.cleanup();if(fail)h.requests[0].reject(Error('late'));else h.requests[0].resolve({id:12,prompt:'late'});await h.settle();assert.equal(h.lateWrites,0);assert.equal(h.redirects.length,0);assert.equal(h.requests[0].options.signal.aborted,true);}});
test('invalid route admits no new read and aborts the prior one',()=>{const h=setup();h.navigate('12x');h.layout();h.passive();assert.equal(h.requests.length,1);assert.equal(h.requests[0].options.signal.aborted,true);h.cleanup();});

test('StrictMode replay aborts old generation and admits the fresh committed scope',async()=>{const h=setup();h.strictReplay();assert.equal(h.requests.length,2);assert.equal(h.requests[0].options.signal.aborted,true);h.requests[0].resolve({id:12,prompt:'obsolete'});await h.settle();assert.equal(h.view.run,null);h.requests[1].resolve({id:12,prompt:'current'});await h.settle();assert.equal(h.view.run.prompt,'current');assert.equal(h.view.readScope,h.view.scope);h.cleanup();});
test('legacy session changes do not add authenticated-read gating or reloads',async()=>{const h=setup(false);h.session({data:null,status:'unauthenticated'});h.layout();h.passive();assert.equal(h.requests.length,1);h.requests[0].resolve({id:12,prompt:'legacy'});await h.settle();assert.equal(h.view.run.prompt,'legacy');h.cleanup();});
test('retained saved data is hidden by readScope immediately on render before layout or passive effects',async()=>{const h=setup();h.requests[0].resolve({id:12,prompt:'prior saved source'});await h.settle();assert.equal(h.view.readScope,h.view.scope);assert.equal(h.view.loading,false);h.navigate('13');assert.notEqual(h.view.readScope,h.view.scope);assert.match(source,/if \(loading\|\|uat2&&readScope!==scope\)/);h.cleanup();});
