import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {harness,nodes,text} from './helpers/workspace-hooks.mjs';

function detail({uat2=true,id='7',status='authenticated'}={}) {
  const identity={id:'1',generation:'a',status},props={params:{id}},reads=[],sockets=[];
  const saved=process.env.NEXT_PUBLIC_UAT2;
  const withFlag=fn=>{process.env.NEXT_PUBLIC_UAT2=String(uat2);try{return fn();}finally{if(saved===undefined)delete process.env.NEXT_PUBLIC_UAT2;else process.env.NEXT_PUBLIC_UAT2=saved;}};
  const request=(url,options={})=>new Promise((resolve,reject)=>reads.push({url,options,resolve,reject}));
  const h=withFlag(()=>harness(new URL('../app/console/jobs/[id]/page.tsx',import.meta.url),'JobDetailPage',props,{
    use:value=>value,useRouter:()=>({back(){}}),useSession:()=>({status:identity.status,data:{user:{id:identity.id},generation:identity.generation}}),useWorkspaceDisplay:()=>({value:{masked:true}}),
    TERMINAL_STATUSES:new Set(['completed','failed']),STATUS_ICONS:{},STATUS_STYLES:{},apiService:{get:request,getJob:request},URLs:{jobs:{get:id=>`/jobs/${id}`,wsJob:id=>`/ws/${id}`}},normalizeError:e=>e.message,
    WSClient:class{constructor(options){this.options=options;this.closed=0;sockets.push(this);}connect(){}close(){this.closed++;}},cn:()=>'',Button:'button',Loader2:'icon',ArrowLeft:'icon',RefreshCw:'icon',AlertCircle:'icon',Clock3:'icon',ExportToSheetsModal:'export',ConceptFSavedText:'saved',OutputConsistencyNotice:'notice',InvestmentRecommendationTable:'output',
  }));
  return {h,identity,props,reads,sockets,flush:async()=>{process.env.NEXT_PUBLIC_UAT2=String(uat2);try{await h.flush();}finally{if(saved===undefined)delete process.env.NEXT_PUBLIC_UAT2;else process.env.NEXT_PUBLIC_UAT2=saved;}}};
}
const record=(id=7,status='completed')=>({id,status,prompt:'saved prompt',provider:'synthetic',model:'offline',response:null});
test('saved detail reads are bounded, exact and never start a UAT2 socket',async()=>{
 const x=detail();assert.equal(x.sockets.length,0);assert.equal(x.reads[0].url,'/jobs/7');assert.equal(x.reads[0].options.cache,'no-store');assert.equal(x.reads[0].options.timeoutMs,8000);
 x.reads[0].resolve(record());await x.flush();assert.match(x.h.text(),/Job #7/);assert.match(x.h.text(),/No saved response supplied/);x.h.cleanup();assert.equal(x.reads[0].options.signal.aborted,true);
});
test('owner, session and route transitions hide old jobs and reject late reads',async()=>{
 for(const kind of ['owner','generation','route','logout']){
  const x=detail();x.reads[0].resolve(record());await x.flush();x.h.button('Refresh').props.onClick();await x.flush();const pending=x.reads.at(-1);
  if(kind==='owner')x.identity.id='2';if(kind==='generation')x.identity.generation='b';if(kind==='route')x.props.params={id:'8'};if(kind==='logout')x.identity.status='unauthenticated';
  await x.flush();assert.doesNotMatch(x.h.text(),/Job #7/);assert.equal(pending.options.signal.aborted,true);pending.resolve(record());await x.flush();assert.doesNotMatch(x.h.text(),/Job #7/);x.h.cleanup();
 }
});
test('refresh cancels immediately and cannot show an older result; invalid identities fail closed',async()=>{
 const x=detail();x.reads[0].resolve(record());await x.flush();const refresh=x.h.button('Refresh').props.onClick;refresh();assert.equal(x.reads[0].options.signal.aborted,true);await x.flush();const old=x.reads.at(-1);refresh();assert.equal(old.options.signal.aborted,true);await x.flush();old.resolve(record());await x.flush();assert.match(x.h.text(),/Loading job/);x.reads.at(-1).resolve(record(8));await x.flush();assert.match(x.h.text(),/could not be verified/);x.h.cleanup();
 const invalid=detail({id:'7-other'});await invalid.flush();assert.equal(invalid.reads.length,0);assert.match(invalid.h.text(),/could not be verified/);invalid.h.cleanup();
});
test('unmount cancels saved reads and production refresh retains its single WS subscription',async()=>{
 const x=detail();x.h.cleanup();x.reads[0].resolve(record());await x.flush();assert.doesNotMatch(x.h.text(),/Job #7/);
 const legacy=detail({uat2:false});legacy.reads[0].resolve(record(7,'processing'));await legacy.flush();legacy.h.button('Refresh').props.onClick();await legacy.flush();assert.equal(legacy.sockets.length,1);legacy.reads.at(-1).resolve(record(7,'processing'));await legacy.flush();legacy.sockets[0].options.onMessage({type:'job.updated',job_id:7,status:'failed'});await legacy.flush();assert.match(legacy.h.text(),/failed/);assert.equal(legacy.sockets[0].closed,1);legacy.h.cleanup();
});

function themeHarness({stored='system',dark=true,disabled=false}={}) {
 const listeners=new Map(),mediaListeners=new Set(),writes=[],subscriptions=[],slots=[];let i=0,tree,notifications=0;
 const window={addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key),matchMedia:()=>({matches:dark,addEventListener:(_key,fn)=>mediaListeners.add(fn),removeEventListener:(_key,fn)=>mediaListeners.delete(fn)})};
 const react={useRef:value=>{const n=i++;return slots[n]??(slots[n]={current:value});},useState:value=>{const n=i++;if(!(n in slots))slots[n]=typeof value==='function'?value():value;return[slots[n],value=>{slots[n]=typeof value==='function'?value(slots[n]):value;}];},useSyncExternalStore:(subscribe,snapshot,server)=>{const n=i++;if(!(n in slots)){slots[n]=true;subscriptions.push(subscribe(()=>notifications++));assert.ok(['light',false].includes(server()));}return snapshot();}};
 const theme={isThemePreference:value=>['light','dark','system'].includes(value),getStoredThemePreference:()=>stored,persistThemePreference:value=>{writes.push(['persist',value]);stored=value;listeners.get('theme')?.(new CustomEvent('theme',{detail:value}));},applyThemePreference:value=>writes.push(['apply',value]),THEME_CHANGED_EVENT:'theme',THEME_STORAGE_KEY:'key'};
 const imports={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},'lucide-react':{Loader2:'icon',Monitor:'icon',Moon:'icon',Sun:'icon'},'@/lib/theme':theme,'@/lib/utils':{cn:()=>''},'@/services/api':{apiService:{updateProfile:async value=>writes.push(['profile',value])}}};
 const out={};new Function('require','exports','window',ts.transpileModule(readFileSync(new URL('../app/console/_components/SidebarThemeToggle.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.ok(name in imports,name);return imports[name];},out,window);
 const render=()=>{i=0;tree=out.SidebarThemeToggle({presentation:'profile',disabled});return tree;};render();
 return {writes,render,button:label=>nodes(tree).find(n=>n.type==='button'&&text(n)===label),listeners,mediaListeners,notifications:()=>notifications,setStored:value=>stored=value,setDark:value=>dark=value,cleanup:()=>subscriptions.forEach(fn=>fn())};
}
test('theme observes same-tab, storage and OS changes without implicit profile/settings writes',()=>{
 const x=themeHarness();assert.equal(x.button('System').props['aria-pressed'],true);assert.match(text(x.render()),/dark/);assert.deepEqual(x.writes,[]);
 x.setDark(false);for(const fn of x.mediaListeners)fn();assert.match(text(x.render()),/light/);
 x.setStored('dark');x.listeners.get('storage')({key:'unrelated'});assert.equal(x.notifications(),1);x.listeners.get('storage')({key:'key'});x.render();assert.equal(x.button('Dark').props['aria-pressed'],true);
 x.listeners.get('theme')(new CustomEvent('theme',{detail:'light'}));x.render();assert.equal(x.button('Calm light').props['aria-pressed'],true);assert.deepEqual(x.writes,[]);x.listeners.get('storage')({key:null});x.render();assert.equal(x.button('Dark').props['aria-pressed'],true);x.cleanup();assert.equal(x.listeners.size,0);assert.equal(x.mediaListeners.size,0);
});
test('theme changes write only on explicit control and disabled controls cannot save',async()=>{
 const x=themeHarness({stored:'light'});await x.button('Dark').props.onClick();x.render();assert.equal(x.button('Dark').props['aria-pressed'],true);assert.deepEqual(x.writes,[['persist','dark'],['apply','dark'],['profile',{theme_preference:'dark'}]]);x.cleanup();
 const disabled=themeHarness({stored:'light',disabled:true});await disabled.button('Dark').props.onClick();assert.deepEqual(disabled.writes,[]);disabled.cleanup();
});

test('actual theme helper persists before notification and storage failure emits no false saved event',()=>{
 const events=[],storage=new Map(),out={};let fail=false;
 const window={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{if(fail)throw new Error('synthetic storage failure');storage.set(key,value);},removeItem:key=>storage.delete(key)},dispatchEvent:event=>events.push(event)};
 new Function('exports','window',ts.transpileModule(readFileSync(new URL('../lib/theme.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,window);
 out.persistThemePreference('dark');assert.equal(out.getStoredThemePreference(),'dark');assert.equal(events.length,1);assert.equal(events[0].detail,'dark');fail=true;assert.throws(()=>out.persistThemePreference('light'),/synthetic storage failure/);assert.equal(events.length,1);assert.equal(out.getStoredThemePreference(),'dark');
});
