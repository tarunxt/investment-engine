import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const technical={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/conceptFTechnical.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(technical);
function harness(initialQuery=""){let slots=[],cursor=0,effects=[],cleanups=[],dirty=true,tree;const requests=[],routes=[];let accepted=0;const react={useState(init){const i=cursor++;if(!(i in slots))slots[i]=init;return[slots[i],v=>{slots[i]=v;dirty=true;}];},useRef(init){const i=cursor++;return slots[i]??(slots[i]={current:init});},useEffect(fn){const i=cursor++;if(!(i in slots)){slots[i]=true;effects.push(fn);}}};const out={},imports={'@/lib/conceptFTechnical':technical,react,'next/navigation':{useSearchParams:()=>new URLSearchParams(initialQuery),usePathname:()=>'/console/zerodha/portfolio',useRouter:()=>({replace:path=>routes.push(path)})},'@/services/api':{apiService:{fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))}},'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'}};const js=ts.transpileModule(readFileSync(new URL('../components/workspace/ConceptFSnapshotReview.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','exports',js)(name=>{assert.ok(name in imports,name);return imports[name];},out);
function nodes(node,result=[]){if(!node||typeof node!=='object')return result;if(node.type)result.push(node);for(const child of [node.props?.children].flat(2))nodes(child,result);return result;}
async function flush(){for(let i=0;i<4;i++){if(dirty){dirty=false;cursor=0;tree=out.ConceptFSnapshotReview({owner:1,onAccepted:()=>accepted++});effects.splice(0).forEach(fn=>cleanups.push(fn()));}await new Promise(setImmediate);}}
return{requests,routes,flush,cleanup:()=>cleanups.forEach(fn=>fn?.()),button:label=>nodes(tree).find(n=>n.type==='button'&&n.props.children===label),text:()=>JSON.stringify(tree),accepted:()=>accepted};}
const preview=(owner=1)=>({id:'10000000-0000-4000-8000-000000000001',owner_id:owner,simulation_only:true,orders_authorized:false,review_digest:'a'.repeat(64),state:'preview',accepted_receipt:null,is_current:false,review:{owner_id:owner,simulation_only:true,module_version:1,base_receipt:null,base_hash:null,captured_at:'2026-10-25T00:00:00Z',expires_at:'2026-10-27T00:00:00Z',proposed:{holdings:[],currency:'INR',source_receipt_id:'receipt',content_hash:'b'.repeat(64)}}});
test('no automatic source request, preview requires deliberate action and survives lost result using same key',async()=>{const h=harness();await h.flush();assert.equal(h.requests.length,0);const first=h.button('Preview synthetic snapshot').props.onClick();await h.flush();assert.equal(h.requests.length,1);assert.match(h.routes[0],/sourceReviewKey=/);const key=JSON.parse(h.requests[0].options.body).key;h.requests[0].reject(new Error('lost'));await first;await h.flush();h.button('Inspect same preview request').props.onClick();await h.flush();assert.equal(JSON.parse(h.requests[1].options.body).key,key);assert.equal(h.accepted(),0);});
test('exact confirmation latch prevents duplicate accept and uncertain result blocks another submit until status read',async()=>{const h=harness();await h.flush();h.button('Preview synthetic snapshot').props.onClick();h.requests[0].resolve(preview());await h.flush();const click=h.button('Accept exact simulation snapshot').props.onClick;click();click();await h.flush();assert.equal(h.requests.length,2);assert.deepEqual(JSON.parse(h.requests[1].options.body),{review_digest:'a'.repeat(64)});h.requests[1].reject(new Error('lost'));await h.flush();assert.equal(h.button('Accept exact simulation snapshot').props.disabled,true);h.button('Inspect persisted review').props.onClick();await h.flush();assert.equal(h.requests[2].options.method,'GET');h.requests[2].resolve({...preview(),state:'accepted',accepted_receipt:'receipt',is_current:true});await h.flush();assert.equal(h.accepted(),1);assert.equal(h.button('Accept exact simulation snapshot').props.disabled,true);});
test('foreign owner response never renders source or authorizes acceptance',async()=>{const h=harness();await h.flush();h.button('Preview synthetic snapshot').props.onClick();h.requests[0].resolve(preview(2));await h.flush();assert.equal(h.button('Accept exact simulation snapshot'),undefined);assert.equal(h.accepted(),0);assert.match(h.text(),/uncertain/);});

test('unsupported added study denies acceptance instead of silently hiding new source bytes',async()=>{const h=harness();await h.flush();h.button('Preview synthetic snapshot').props.onClick();const value=preview();value.review.proposed.price_history={provider:'unknown'};h.requests[0].resolve(value);await h.flush();assert.equal(h.button('Accept exact simulation snapshot'),undefined);assert.equal(h.accepted(),0);assert.match(h.text(),/uncertain/);});


test('F12 retired review lifetime ignores late accepted response and does not refresh newer navigation',async()=>{
 const h=harness();await h.flush();h.button('Preview synthetic snapshot').props.onClick();h.requests[0].resolve(preview());await h.flush();
 h.button('Accept exact simulation snapshot').props.onClick();await h.flush();h.cleanup();
 h.requests[1].resolve({...preview(),state:'accepted',accepted_receipt:'receipt',is_current:true});await h.flush();
 assert.equal(h.accepted(),0);assert.doesNotMatch(h.text(),/Exact snapshot accepted and current/);
});

test('F12 retired preview lifetime cannot pin its late response over newer review navigation',async()=>{
 const h=harness();await h.flush();h.button('Preview synthetic snapshot').props.onClick();await h.flush();const before=[...h.routes];h.cleanup();
 h.requests[0].resolve(preview());await h.flush();assert.deepEqual(h.routes,before);assert.equal(h.accepted(),0);
});


test('F12/F26 pinned review loading cannot start a replacement preview',async()=>{
 const h=harness('sourceReview=10000000-0000-4000-8000-000000000001');await h.flush();assert.equal(h.requests.length,1);assert.equal(h.button('Preview synthetic snapshot'),undefined);assert.match(h.text(),/Reading pinned snapshot review/);assert.ok(h.button('Keep current snapshot'));
 h.requests[0].reject(new Error('offline'));await h.flush();assert.equal(h.button('Preview synthetic snapshot'),undefined);assert.match(h.text(),/Pinned review unavailable/);assert.equal(h.requests.length,1);
});

test('F12 invalid pinned identity is not a loading state and cannot silently start a new preview',async()=>{
 const h=harness('sourceReview=invalid');await h.flush();assert.equal(h.requests.length,0);assert.equal(h.button('Preview synthetic snapshot'),undefined);assert.match(h.text(),/Pinned review identity is invalid/);h.button('Keep current snapshot').props.onClick();assert.equal(new URL(h.routes.at(-1),'https://synthetic.invalid').searchParams.has('sourceReview'),false);
});


test('F12 pinned same-owner response with another identity reports mismatch instead of loading forever',async()=>{
 const h=harness('sourceReview=10000000-0000-4000-8000-000000000002');await h.flush();h.requests[0].resolve(preview());await h.flush();assert.match(h.text(),/Pinned review unavailable/);assert.doesNotMatch(h.text(),/Reading pinned snapshot review/);assert.equal(h.button('Accept exact simulation snapshot'),undefined);assert.equal(h.requests.length,1);
});


test('F12 accept and explicit status reject another same-owner review rather than acknowledging it',async()=>{
 for(const label of ['Accept exact simulation snapshot','Inspect persisted review']){
  const h=harness();await h.flush();h.button('Preview synthetic snapshot').props.onClick();h.requests[0].resolve(preview());await h.flush();h.button(label).props.onClick();await h.flush();
  h.requests[1].resolve({...preview(),id:'10000000-0000-4000-8000-000000000002',state:'accepted',accepted_receipt:'other',is_current:true});await h.flush();assert.equal(h.accepted(),0);assert.doesNotMatch(h.text(),/Exact snapshot accepted and current/);assert.match(h.text(),/uncertain|unverified/);
 }
});
