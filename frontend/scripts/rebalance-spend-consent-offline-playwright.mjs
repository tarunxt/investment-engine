/** Real React consent + authorization lifecycle; local fake API, no provider/network. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Existing isolated audit tooling; override to another local dependency directory.
const deps = process.env.CAP_TEST_NODE_MODULES || path.join(root, 'node_modules');
const require = createRequire(path.join(deps, '../cap-test.cjs'));
const ts = require('typescript');
const { chromium } = process.env.CAP_TEST_PLAYWRIGHT_PACKAGE ? createRequire(process.env.CAP_TEST_PLAYWRIGHT_PACKAGE)('playwright') : require('playwright');
const modules = [], ids = new Map();
function add(file, source) {
 if (ids.has(file)) return ids.get(file);
 const id = modules.length; ids.set(file, id); modules.push('');
 let code = source ?? readFileSync(file, 'utf8');
 if (/\.tsx?$/.test(file)) code = ts.transpileModule(code, {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 code = code.replace(/require\(["']([^"']+)["']\)/g, (_, name) => {
   let next;
   if (name.startsWith('.')) {
     const base = path.resolve(path.dirname(file),name);
     for (const ext of ['', '.ts','.tsx','.js']) { try { readFileSync(base+ext); next=base+ext; break; } catch {} }
   } else next = require.resolve(name);
   if (!next) throw Error('Cannot resolve '+name);
   return `__require(${add(next)})`;
 });
 modules[id] = `function(module,exports,__require){${code}\n}`;
 return id;
}
const entry = add(path.join(root,'cap-fixture.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {RebalanceSpendConsent} from './components/shared/RebalanceSpendConsent';
import {authorizeAndClaimWorkflow} from './lib/rebalanceSpendAuthorization';
window.calls=[];window.available=true;window.fail=false;window.authorizeAndClaimWorkflow=authorizeAndClaimWorkflow;
const load=async(market)=>{const result=await fetch('/readiness?market='+market).then(r=>r.json());return {...result,portfolio:market,cap_inr:'20',paid_execution_available:window.available,reason:'No adapter has verified price, FX/fees and request bounds. No paid request will be dispatched.',scopes:[{id:7,status:'open',cap_inr:'20',settled_inr:'4',reserved_inr:'3',created_at:'2026-11-01'}]};};
function Fixture(){const [choice,setChoice]=useState(null),[message,setMessage]=useState(''),[revision,setRevision]=useState(0),[market,setMarket]=useState('india');
const start=async()=>{if(!choice){setMessage('Choose explicitly');return;}const captured=choice;setChoice(null);try{const result=await authorizeAndClaimWorkflow({owner:1,market,choice:captured,reserve:async(auth)=>{window.calls.push(auth);if(window.failBefore)throw Error('No response before dispatch');const response=await fetch('/reserve',{method:'POST',body:JSON.stringify({market,...auth})});const result=await response.json();if(!response.ok)throw Error(result.message);if(window.fail)throw Error('Uncertain response');return result;});window.executions=(window.executions||0)+1;setMessage('Started scope '+result.spend_scope_id);}catch(e){setMessage(e.message);}finally{setRevision(v=>v+1);}};
return <><button onClick={()=>{setChoice(null);setMarket(m=>m==='india'?'indmoney_us':'india')}}>Switch market</button><RebalanceSpendConsent key={market+revision} owner={1} market={market} load={load} onChoose={setChoice}/><button onClick={start}>Run</button><p role="status" id="result">{message}</p></>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const bundle = `var process={env:{NODE_ENV:'development'}};const modules=[${modules.join(',')}],cache={};function __require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,__require);return m.exports;}__require(${entry});`;
let browser; const grants=new Map(),revisions=new Map();let sequence=0;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/readiness')){const market=new URL(req.url,'http://localhost').searchParams.get('market');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authorization_revision:revisions.get(market)||0}));return;}
 if(req.url==='/reserve'){let raw='';for await(const chunk of req)raw+=chunk;const auth=JSON.parse(raw);res.setHeader('Content-Type','application/json');
 const prior=grants.get(auth.spend_request_id);if(prior){res.end(JSON.stringify({...prior,reservation_created:false}));return;}
 if(auth.spend_observed_revision!==(revisions.get(auth.market)||0)){res.statusCode=409;res.end(JSON.stringify({message:'Workflow authorization changed in another tab; refresh readiness.'}));return;}
 sequence++;revisions.set(auth.market,sequence);const value={portfolio:auth.market,sequence,label:'fixture',spend_scope_id:auth.spend_scope_id||sequence};grants.set(auth.spend_request_id,value);res.end(JSON.stringify({...value,reservation_created:true}));return;}
 res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:'<div id="root"></div><script src="/bundle.js"></script>');
});
try {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext();await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);const select=page.getByLabel('Workflow authorization');await select.waitFor();
 await page.getByRole('button',{name:'Run',exact:true}).click();assert.match(await page.locator('#result').innerText(),/Choose explicitly/);
 await select.selectOption('new');await page.getByRole('button',{name:'Run',exact:true}).dblclick();await page.waitForFunction(()=>window.executions===1);assert.equal(await page.evaluate(()=>window.calls.length),1);
 await page.reload();await select.waitFor();assert.equal(await select.inputValue(),'');assert.equal(await page.evaluate(()=>window.calls.length),0);
 await select.selectOption('7');await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>window.executions===1);assert.equal(await page.evaluate(()=>window.calls[0].spend_scope_id),7);
 // Unknown response: durable UUID survives navigation; retry reconciles without dispatch.
 await page.evaluate(()=>{window.fail=true});await select.selectOption('new');await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('Uncertain'));
 const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('credx:rebalance-spend:v1:1:india')).authorization.spend_request_id);
 await page.getByRole('button',{name:'Switch market'}).click();await page.getByRole('button',{name:'Switch market'}).click();await page.reload();await select.waitFor();assert.equal(await page.evaluate(()=>window.calls.length),0);await select.selectOption('retry');
 await page.evaluate(()=>{window.fail=false});await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('No stages restarted'));
 assert.equal(await page.evaluate(()=>window.calls.at(-1).spend_request_id),pending);assert.equal(await page.evaluate(()=>window.executions||0),0);
 // Both markets have independent owner-scoped pending records; a second tab cannot renew pending grant.
 const second=await context.newPage();await second.goto(origin);await second.getByLabel('Workflow authorization').waitFor();assert.equal(await second.getByLabel('Workflow authorization').inputValue(),'');
 // Two tabs selected against the same prior request cannot both mint new allowances.
 await select.selectOption('new');await second.getByLabel('Workflow authorization').selectOption('new');
 const before=await page.evaluate(()=>window.calls.length);
 await Promise.all([page.getByRole('button',{name:'Run',exact:true}).click(),second.getByRole('button',{name:'Run',exact:true}).click()]);
 await page.waitForTimeout(150);
 assert.equal(grants.size,4); // new, continuation, uncertain/replayed, and exactly one concurrent new grant
 assert.match((await page.locator('#result').innerText())+' '+(await second.locator('#result').innerText()),/another tab/);
 await page.evaluate(()=>window.available=false);await page.getByRole('button',{name:'Refresh allowance readiness'}).click();await page.getByRole('alert').waitFor();assert.equal(await select.isDisabled(),true);assert.match(await page.getByRole('alert').innerText(),/No paid request/);
 // Missing browser locking fails closed. A pre-dispatch failure resolves without automatic stages.
 const lockingMessage=await page.evaluate(async()=>{try{await window.authorizeAndClaimWorkflow({owner:1,market:'india',choice:{intent:'new_workflow',revision:0},locks:null,reserve:()=>{throw Error('MUST NOT CALL')}});}catch(e){return e.message}});assert.match(lockingMessage,/Web Locks/);
 await page.evaluate(()=>{window.available=true;window.failBefore=true});await page.getByRole('button',{name:'Refresh allowance readiness'}).click();await select.selectOption('new');await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('No response before'));
 const grantsBefore=grants.size;await page.reload();await select.selectOption('retry');await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('No stages restarted'));assert.equal(grants.size,grantsBefore+1);assert.equal(await page.evaluate(()=>window.executions||0),0);
 assert.deepEqual(errors,[]);console.log('PASS: actual consent component new/continue/duplicate/reload/navigation/uncertain retry/second tab/unknown adapter; external requests blocked.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
