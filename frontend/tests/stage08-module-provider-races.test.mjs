import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/stage08-ready-manifest.json',import.meta.url)));
function compile(file,imports){
 const exports={};const source=readFileSync(new URL(file,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports',js)(name=>{assert.ok(name in imports,`Unmocked import ${name}`);return imports[name];},exports);return exports;
}
const policy=compile('../lib/modulePolicy.ts',{});
function manifest(version,enabled=false,owner=fixture.owner_id){
 const value=structuredClone(fixture);value.owner_id=owner;value.version=version;
 for(const m of value.modules){m.selection.enabled=m.module_id==='zerodha_rebalance'&&enabled;m.selection.version=m.selection.enabled?version:0;for(const c of Object.values(m.capabilities))c.allowed=m.selection.enabled;}
 return value;
}
const tick=()=>new Promise(setImmediate);
function harness(){
 const previous={window:globalThis.window,BroadcastChannel:globalThis.BroadcastChannel};
 let slots=[],cursor=0,pending=[],dirty=false,owner=fixture.owner_id,generation='session-a',status='authenticated',bus;
 const calls=[],installed=[];let requestsPolicy;
 globalThis.window={location:{origin:'http://synthetic.invalid'},setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}};
 requestsPolicy=compile('../lib/moduleRequests.ts',{'./modulePolicy':policy});
 globalThis.BroadcastChannel=class{constructor(){bus=this;}postMessage(){}close(){}};
 const same=(a,b)=>a?.length===b?.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;dirty=true;}];},
  useRef(value){const i=cursor++;return slots[i]??(slots[i]={current:value});},
  useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,fn};return slots[i].fn;},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};pending.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
 };
 const api={fetch(url,options={}){return new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}));}};
 const {ModuleProvider}=compile('../providers/ModuleProvider.tsx',{
  react,'react/jsx-runtime':{jsx:(type,props)=>({type,props})},'next-auth/react':{useSession:()=>({data:{generation},status})},
  './ModuleContext':{ModulesContext:{Provider:'Provider'}},'next/navigation':{usePathname:()=>'/console/profile/preferences'},
  '@/hooks/useAuth':{useAuth:()=>({user:owner===null?null:{id:owner}})},'@/services/api':{apiService:api},'@/lib/modulePolicy':policy,
  '@/lib/moduleRequests':{...requestsPolicy,installModulePolicy:data=>{installed.push(data);requestsPolicy.installModulePolicy(data);},clearModulePolicy:()=>{installed.push(null);requestsPolicy.clearModulePolicy();}},
  '@/services/privateSocketRegistry':{closePrivateWebSockets(){}},'@/lib/privateDashboardCache':{purgeBrowserPrivateDashboardCaches(){}},
 });
 let value;
 function render(){cursor=0;dirty=false;value=ModuleProvider({children:null}).props.value;return value;}
 async function flush(){for(let i=0;i<10;i++){if(dirty||!value)render();const effects=pending.splice(0);effects.forEach(f=>f());await tick();if(!dirty&&!pending.length)return value;}throw Error('Hooks did not settle');}
 async function start(){render();await flush();calls.filter(c=>!c.options.method).forEach(c=>c.resolve(manifest(1)));await flush();assert.equal(value.manifest.version,1);return value;}
 function save(){const promise=value.save('zerodha_rebalance',true);promise.catch(()=>{});return promise;}
 return {calls,installed,get value(){return value;},get gate(){return requestsPolicy;},start,save,flush,render,
  invalidate(version){bus.onmessage({data:{owner,version}});},
  switchIdentity(nextOwner,nextGeneration=generation,nextStatus='authenticated'){owner=nextOwner;generation=nextGeneration;status=nextStatus;render();},
  close(){slots.forEach(slot=>slot?.cleanup?.());globalThis.window=previous.window;globalThis.BroadcastChannel=previous.BroadcastChannel;},
 };
}
function patch(h){return h.calls.findLast(c=>c.options.method==='PATCH');}
function get(h){return h.calls.findLast(c=>!c.options.method);}
function closed(h){assert.equal(h.value.manifest,null);assert.throws(()=>h.gate.moduleRequestSignal('/backend-api/zerodha/portfolio'),{name:'AbortError'});}

test('delayed PATCH v2 cannot reopen policy after disable v3 invalidation; fresh GET required',async()=>{
 const h=harness();try{await h.start();const saving=h.save();const old=patch(h);h.invalidate(3);await h.flush();closed(h);const fresh=get(h);
  old.resolve(manifest(2,true));await assert.rejects(saving,/another tab or session/);await h.flush();closed(h);
  fresh.resolve(manifest(3));await h.flush();assert.equal(h.value.manifest.version,3);assert.equal(policy.allowedModule(h.value.manifest,'zerodha_rebalance'),false);
  assert.equal(h.installed.some(m=>m?.version===2),false);
 }finally{h.close();}
});
test('stale mutation success and failure preserve a newer authoritative GET',async()=>{
 for(const failure of [false,true]){const h=harness();try{await h.start();const saving=h.save();const old=patch(h);h.invalidate(4);await h.flush();get(h).resolve(manifest(4));await h.flush();
  if(failure)old.reject(Error('old network failure'));else old.resolve(manifest(2,true));await assert.rejects(saving);await h.flush();assert.equal(h.value.manifest.version,4);assert.equal(policy.allowedModule(h.value.manifest,'zerodha_rebalance'),false);
 }finally{h.close();}}
});
test('version high-water mark survives closed state and rejects stale GET; retry admits current policy',async()=>{
 const h=harness();try{await h.start();h.invalidate(5);await h.flush();get(h).resolve(manifest(4,true));await h.flush();closed(h);assert.match(h.value.error,/newer/);
  const retry=h.value.refresh();get(h).resolve(manifest(5));await retry;await h.flush();assert.equal(h.value.manifest.version,5);
 }finally{h.close();}
});
test('read started before invalidation cannot overwrite the authoritative replacement',async()=>{
 const h=harness();try{await h.start();const reading=h.value.refresh();const old=get(h);h.invalidate(3);await h.flush();const fresh=get(h);old.resolve(manifest(2,true));await reading;await h.flush();closed(h);
  fresh.resolve(manifest(3));await h.flush();assert.equal(h.value.manifest.version,3);
 }finally{h.close();}
});
test('old mutation completion cannot release a new mutation lock after invalidation',async()=>{
 const h=harness();try{await h.start();const first=h.save();const old=patch(h);h.invalidate(3);await h.flush();get(h).resolve(manifest(3));await h.flush();const second=h.save();const next=patch(h);
  old.resolve(manifest(2,true));await assert.rejects(first);await h.flush();await assert.rejects(h.save(),/Reload/);
  next.resolve(manifest(4,true));await second;await h.flush();assert.equal(h.value.manifest.version,4);
 }finally{h.close();}
});
for(const kind of ['account ABA','logout/login same owner','same-owner new session'])test(`delayed mutation/read rejected across ${kind}`,async()=>{
 const h=harness();try{await h.start();const reading=h.value.refresh();const oldRead=get(h);const saving=h.save();const oldPatch=patch(h);
  if(kind==='account ABA'){h.switchIdentity(fixture.owner_id+1);await h.flush();h.switchIdentity(fixture.owner_id);}
  else if(kind==='logout/login same owner'){h.switchIdentity(null,'session-a','unauthenticated');await h.flush();h.switchIdentity(fixture.owner_id,'session-b');}
  else h.switchIdentity(fixture.owner_id,'session-b');
  await h.flush();const fresh=get(h);oldRead.resolve(manifest(8,true));oldPatch.resolve(manifest(9,true));await reading;await assert.rejects(saving);await h.flush();closed(h);
  // A new session has its own version floor, even for the same account.
  fresh.resolve(manifest(1));await h.flush();assert.equal(h.value.manifest.version,1);assert.equal(policy.allowedModule(h.value.manifest,'zerodha_rebalance'),false);
 }finally{h.close();}
});
test('unmounted provider rejects late read/mutation without installing policy',async()=>{
 const h=harness();await h.start();const saving=h.save();const old=patch(h);h.close();const count=h.installed.length;old.resolve(manifest(2,true));await assert.rejects(saving);await tick();assert.equal(h.installed.length,count);
});
