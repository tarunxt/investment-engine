import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function harness(){
 let slots=[],cursor=0,pending=[],dirty=true,owner=1,generation='a',status='authenticated',tree;
 const calls=[];const same=(a,b)=>a?.length===b?.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;dirty=true;}];},useRef(value){const i=cursor++;return slots[i]??(slots[i]={current:value});},useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};pending.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}}};
 const imports={react,'react/jsx-runtime':{jsx:(type,props,key)=>({type,props:{...props,key}}),jsxs:(type,props,key)=>({type,props:{...props,key}})},'@/hooks/useAuth':{useAuth:()=>({user:owner?{id:owner}:null})},'next-auth/react':{useSession:()=>({data:{generation},status})},'@/services/api':{apiService:{fetch(url,options){return new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}));}}}};
 const exports={};const js=ts.transpileModule(readFileSync(new URL('../components/connections/ConnectionAuthorization.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports',js)(name=>{assert.ok(name in imports,name);return imports[name];},exports);
 async function flush(){for(let i=0;i<10;i++){if(dirty){cursor=0;dirty=false;tree=exports.AuthorizationFlow({owner});}pending.splice(0).forEach(f=>f());await new Promise(setImmediate);if(!dirty&&!pending.length)return tree;}throw Error('Unsettled hooks');}
 return{calls,flush,wrapper:()=>exports.ConnectionAuthorization({}),renderNow(){cursor=0;dirty=false;tree=exports.AuthorizationFlow({owner});return tree;},tree:()=>tree,switch(id,g=String(id)){owner=id;generation=g;dirty=true;},logout(){status='unauthenticated';owner=null;dirty=true;}};
}

function buttons(tree){if(!tree||typeof tree!=='object')return[];return [...(tree.type==='button'?[tree]:[]),...Object.values(tree.props??{}).flatMap(v=>Array.isArray(v)?v.flatMap(buttons):buttons(v))];}
function text(node){return JSON.stringify(node);}
test('unconfigured runtime exposes no synthetic authorization action',async()=>{const h=harness();await h.flush();h.calls[0].reject(Error('disabled'));await h.flush();assert.match(text(h.tree()),/Authorization is unavailable/);assert.equal(buttons(h.tree()).length,0);});
test('foreign metadata never displays private account data',async()=>{const h=harness();await h.flush();h.calls[0].resolve({enabled:true,simulation:true});await h.flush();h.calls[1].resolve({owner_id:2,connections:[{account_label:'PRIVATE'}]});await h.flush();assert.doesNotMatch(text(h.tree()),/PRIVATE/);assert.match(text(h.tree()),/unavailable/);});
test('owner and session generation key remounts the complete authorization flow',()=>{const h=harness();const first=h.wrapper();h.switch(1,'new');assert.notEqual(first.props.key,h.wrapper().props.key);h.logout();assert.equal(h.wrapper(),null);});
for(const mode of ['user_owned','platform_managed'])test('synthetic setup sends only mode and requires explicit callback for '+mode,async()=>{
 const h=harness();await h.flush();h.calls[0].resolve({enabled:true,simulation:true});await h.flush();h.calls[1].resolve({owner_id:1,connections:[]});await h.flush();
 const button=buttons(h.tree()).find(v=>text(v).includes(mode==='user_owned'?'your own Kite app':'CredX-managed app'));assert.ok(button);button.props.onClick();await h.flush();assert.deepEqual(JSON.parse(h.calls[2].options.body),{mode});
 h.calls[2].resolve({connection_id:'candidate',version:1});await h.flush();assert.match(h.calls[3].url,/start$/);h.calls[3].resolve({attempt_id:'one-use',state:'synthetic-state',simulation:true,expires_at:'future'});await h.flush();
 assert.ok(buttons(h.tree()).some(v=>text(v).includes('Simulate broker callback')));assert.ok(!buttons(h.tree()).some(v=>text(v).includes('Confirm this account')));
});
