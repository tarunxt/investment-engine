import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(file,bindings={}){const ast=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);const text=ast.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(ast)).join('\n');const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};new Function('module','exports','require',...Object.keys(bindings),js)(module,module.exports,require,...Object.values(bindings));return module.exports;}
const safety=load('../lib/basketSubmissionSafety.ts');
test('affordability rejects missing/nonfinite funds and totals, includes buffer, and preserves funded sell-first',()=>{
 const buy=amount=>({side:'BUY',amount}),sell=amount=>({side:'SELL',amount});
 assert.equal(safety.basketAffordabilityIssue([buy(500)],550),null);
 for(const margin of [null,NaN,Infinity,-1,549.99])assert.ok(safety.basketAffordabilityIssue([buy(500)],margin));
 assert.equal(safety.basketAffordabilityIssue([sell(500),buy(500)],50),null);
 assert.ok(safety.basketAffordabilityIssue([sell(499),buy(500)],50));
 assert.equal(safety.basketAffordabilityIssue([sell(100)],null),null);
 for(const amount of [null,NaN,Infinity,-1])assert.ok(safety.basketAffordabilityIssue([buy(amount)],1000));
 assert.ok(safety.basketAffordabilityIssue([buy(10000)],10099));
 assert.equal(safety.basketAffordabilityIssue([buy(10000)],10100),null);
});
test('only known pre-execution HTTP failures are definitive; timeouts and 5xx remain uncertain',()=>{
 for(const status of [401,403,422])assert.equal(safety.definitiveBasketRejection({status}),true);
 for(const error of [{status:500},{status:502},{status:503},{status:504},new Error('timeout'),new Error('network'),{}])assert.equal(safety.definitiveBasketRejection(error),false);
});
function harness(storage=new Map()){
 let slots=[],cursor=0,effects=[];const listeners=new Map();
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 const bindings={...safety,navigator:{locks:{request:async(_,__,fn)=>fn({})}},localStorage,window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){slots[i]=deps;effects.push(fn);}}};
 const {useBasketSubmissionSafety}=load('../hooks/useBasketSubmissionSafety.ts',bindings);
 const render=(owner=71)=>{cursor=0;const value=useBasketSubmissionSafety(owner);for(const fn of effects.splice(0))fn();return value;};
 render();return {render,storage,localStorage,listeners,navigator:bindings.navigator};
}
test('attempt lock survives component remount and user-scoped reload; second attempt cannot start',async()=>{
 const h=harness();assert.equal(h.render().blockedReason,null);await h.render().begin(['NSE:ADD:BUY:5']);
 assert.ok(h.render().blockedReason);await assert.rejects(()=>h.render().begin(['NSE:ADD:BUY:5']));
 h.render().uncertain();assert.equal(JSON.parse(h.storage.get(safety.basketAttemptKey(71))).state,'uncertain');
 const remount=harness(h.storage);assert.ok(remount.render().blockedReason);
 remount.render(72);assert.equal(remount.render(72).blockedReason,null);
 assert.ok(h.storage.get(safety.basketAttemptKey(71)));
});
test('resolved response clears persisted lock; failed storage prevents dispatch admission',async()=>{
 const h=harness();await h.render().begin(['NSE:ADD:BUY:5']);h.render().complete();assert.equal(h.render().blockedReason,null);assert.equal(h.storage.size,0);
 h.localStorage.setItem=()=>{throw Error('storage unavailable')};await assert.rejects(()=>h.render().begin(['NSE:ADD:BUY:5']),/storage unavailable/);assert.ok(h.render().blockedReason);
});
test('other-tab storage change updates the blocker',()=>{
 const h=harness();h.storage.set(safety.basketAttemptKey(71),'pending');h.listeners.get('storage')({key:safety.basketAttemptKey(71)});assert.ok(h.render().blockedReason);
});

test('unavailable cross-tab locking and an occupied admission lock stop before recording an attempt',async()=>{
 const unsupported=harness();unsupported.navigator.locks=null;await assert.rejects(()=>unsupported.render().begin(['NSE:ADD:BUY:5']),/locking is unavailable/);assert.equal(unsupported.storage.size,0);assert.ok(unsupported.render().blockedReason);
 const occupied=harness();occupied.navigator.locks.request=async(_,__,fn)=>fn(null);await assert.rejects(()=>occupied.render().begin(['NSE:ADD:BUY:5']),/Another tab/);assert.equal(occupied.storage.size,0);
});
