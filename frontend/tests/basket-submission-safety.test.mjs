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
 const h=harness();assert.equal(h.render().blockedReason,null);await h.render().begin();
 assert.ok(h.render().blockedReason);await assert.rejects(()=>h.render().begin());
 h.render().uncertain();assert.equal(JSON.parse(h.storage.get(safety.basketAttemptKey(71))).state,'uncertain');
 const remount=harness(h.storage);assert.ok(remount.render().blockedReason);
 remount.render(72);assert.equal(remount.render(72).blockedReason,null);
 assert.ok(h.storage.get(safety.basketAttemptKey(71)));
});
test('resolved response clears persisted lock; failed storage prevents dispatch admission',async()=>{
 const h=harness();await h.render().begin();h.render().complete();assert.equal(h.render().blockedReason,null);assert.equal(h.storage.size,0);
 h.localStorage.setItem=()=>{throw Error('storage unavailable')};await assert.rejects(()=>h.render().begin(),/storage unavailable/);assert.ok(h.render().blockedReason);
});
test('other-tab storage change updates the blocker',()=>{
 const h=harness();h.storage.set(safety.basketAttemptKey(71),'pending');h.listeners.get('storage')({key:safety.basketAttemptKey(71)});assert.ok(h.render().blockedReason);
});

test('unavailable cross-tab locking and an occupied admission lock stop before recording an attempt',async()=>{
 const unsupported=harness();unsupported.navigator.locks=null;await assert.rejects(()=>unsupported.render().begin(),/locking is unavailable/);assert.equal(unsupported.storage.size,0);assert.ok(unsupported.render().blockedReason);
 const occupied=harness();occupied.navigator.locks.request=async(_,__,fn)=>fn(null);await assert.rejects(()=>occupied.render().begin(),/Another tab/);assert.equal(occupied.storage.size,0);
});

const reviewed=[{symbol:'ADD',exchange:'NSE',side:'BUY',units:9}];
const placed=(overrides={})=>({tradingsymbol:'ADD',exchange:'NSE',transaction_type:'BUY',quantity:9,status:'placed',order_id:'receipt-1',...overrides});
const response=(overrides={})=>({sell_results:[],buy_results:[placed()],skipped_buy_results:[],messages:[],placed_count:1,failed_count:0,skipped_count:0,...overrides});
test('only complete consistent response coverage and nonempty unique receipts resolve submission',()=>{
 assert.equal(safety.basketResponseIssue(response(),reviewed),null);
 for(const order_id of [undefined,null,'','  ',7])assert.match(safety.basketResponseIssue(response({buy_results:[placed({order_id})]}),reviewed),/receipt/);
 assert.match(safety.basketResponseIssue(response({buy_results:[],placed_count:0}),reviewed),/every reviewed unit/);
 for(const overrides of [{placed_count:0},{failed_count:1},{skipped_count:1}])assert.match(safety.basketResponseIssue(response(overrides),reviewed),/counts/);
 for(const invalid of [null,{},response({messages:null}),response({buy_results:null}),response({buy_results:[null]})])assert.ok(safety.basketResponseIssue(invalid,reviewed));
});
test('partial results, failed rows, wrong identity/side, duplicate receipts and excess quantities retain uncertainty',()=>{
 for(const overrides of [{quantity:8},{quantity:10},{tradingsymbol:'OTHER'},{exchange:'BSE'},{transaction_type:'SELL'},{status:'unknown'}])assert.ok(safety.basketResponseIssue(response({buy_results:[placed(overrides)]}),reviewed));
 assert.ok(safety.basketResponseIssue(response({buy_results:[placed(),placed()],placed_count:2}),reviewed));
 const two=[...reviewed,{symbol:'OTHER',exchange:'NSE',side:'BUY',units:2}];
 assert.match(safety.basketResponseIssue(response({buy_results:[placed(),placed({tradingsymbol:'OTHER',quantity:2})],placed_count:2}),two),/duplicate broker receipt/);
 const partial=response({buy_results:[placed(),placed({tradingsymbol:'OTHER',quantity:2,status:'failed',order_id:null})],placed_count:1,failed_count:1});
 assert.match(safety.basketResponseIssue(partial,two),/uncertain execution/);
});
test('explicit fully-accounted reduction/skips and mixed sell-first receipts remain valid',()=>{
 const skip={tradingsymbol:'ADD',exchange:'NSE',transaction_type:'BUY',quantity:6,status:'skipped'};
 assert.equal(safety.basketResponseIssue(response({buy_results:[placed({quantity:3})],skipped_buy_results:[skip],skipped_count:1}),reviewed),null);
 assert.equal(safety.basketResponseIssue(response({buy_results:[],placed_count:0,skipped_buy_results:[{...skip,quantity:9}],skipped_count:1}),reviewed),null);
 assert.match(safety.basketResponseIssue(response({buy_results:[],placed_count:0,skipped_buy_results:[{...skip,quantity:9,order_id:'contradictory-receipt'}],skipped_count:1}),reviewed),/non-placed result/);
 const sellDraft={symbol:'SELL',exchange:'NSE',side:'SELL',units:2};const sell=placed({tradingsymbol:'SELL',transaction_type:'SELL',quantity:2,order_id:'receipt-sell'});
 assert.equal(safety.basketResponseIssue(response({sell_results:[sell],placed_count:2}),[sellDraft,...reviewed]),null);
});
test('persisted attempts contain no trading symbols, quantities or legacy listing fields',async()=>{
 const h=harness();await h.render().begin();const record=JSON.parse(h.storage.get(safety.basketAttemptKey(71)));assert.deepEqual(Object.keys(record).sort(),['startedAt','state']);
 h.storage.set(safety.basketAttemptKey(71),JSON.stringify({...record,listings:['NSE:PRIVATE:BUY:5']}));h.render().uncertain();assert.deepEqual(Object.keys(JSON.parse(h.storage.get(safety.basketAttemptKey(71)))).sort(),['startedAt','state']);
});

test('hydration strips legacy listings while retaining the account lock',()=>{
 const storage=new Map([[safety.basketAttemptKey(71),JSON.stringify({startedAt:new Date().toISOString(),state:'uncertain',listings:['NSE:PRIVATE:BUY:5']})]]);
 const h=harness(storage);assert.ok(h.render().blockedReason);assert.deepEqual(Object.keys(JSON.parse(storage.get(safety.basketAttemptKey(71)))).sort(),['startedAt','state']);
});
