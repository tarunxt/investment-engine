#!/usr/bin/env node
/** CI-only real rendered UI + guarded synthetic backend. Never a deploy command. */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const runtime=path.join(root,'.runtime/stage01-preview');
const evidence=path.resolve(process.env.LINKED_BROWSER_EVIDENCE || '/tmp/linked-browser-evidence');
const python=process.env.LINKED_BROWSER_PYTHON || 'python';
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert.match(sourceSha,/^[a-f0-9]{40}$/);
mkdirSync(evidence,{recursive:true});
const receipt={kind:'real_ui_guarded_fake_preview',source_sha:sourceSha,passed:false,checks:[],screenshots:[],
 real_provider_certification:false,deployed_uat2_verified:false,public_runtime_verified:false,
 scope:'Real login, selection, governed India analysis and exact UI approval; synthetic current-version source, fake venue, SQLite. Unknown transition is durable-store evidence, not guaranteed visible UI.',
 launcher_deviation:'Outside-repository copy with fixed ROOT and explicit existing STAGE01_EXECUTION_FAULT only; original guards unchanged.'};
const receiptPath=path.join(evidence,'receipt.json');
function save(){writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');}
save();
// Never reuse a prior preview, imported user database or inherited app environment.
assert(!existsSync(runtime),'Fresh checkout required: existing preview runtime is not disposable by assumption');
for(const folder of [root,path.join(root,'frontend')])for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert(!existsSync(path.join(folder,name)),'Inherited app environment refused');
const launcherSource=readFileSync(path.join(root,'scripts/public_launch/preview.py'),'utf8');
const rootLine='ROOT = Path(__file__).resolve().parents[2]';
const faultAnchor='"STAGE01_PREVIEW": "synthetic-only",';
assert.equal(launcherSource.split(rootLine).length,2);assert.equal(launcherSource.split(faultAnchor).length,2);
let launcher,started=false,browser,launcherChild,launcherClosed;
function makeLauncher(fault){
 assert(['partial','after_acceptance'].includes(fault));
 const text=launcherSource.replace(rootLine,`ROOT = Path(${JSON.stringify(root)})`).replace(faultAnchor,`${faultAnchor} "STAGE01_EXECUTION_FAULT": "${fault}",`);
 launcher=path.join(evidence,`preview-${fault}.py`);writeFileSync(launcher,text);
 receipt.launchers??={};receipt.launchers[fault]=createHash('sha256').update(text).digest('hex');
}
function command(args,timeout=120000){return execFileSync(python,[launcher,...args],{cwd:root,encoding:'utf8',timeout,maxBuffer:4*1024*1024});}
async function start(fault){
 makeLauncher(fault);started=true;
 launcherChild=spawn(python,['-u',launcher,'start','--foreground'],{cwd:root,stdio:['ignore','pipe','pipe']});
 let output='';launcherClosed=false;let launchError;
 launcherChild.once('error',e=>{launchError=e;launcherClosed=true;});launcherChild.once('close',()=>{launcherClosed=true;});
 const collect=chunk=>{output+=chunk;writeFileSync(path.join(evidence,`startup-${fault}.log`),output);};
 launcherChild.stdout.on('data',collect);launcherChild.stderr.on('data',collect);
 await until(()=>{if(launchError)throw launchError;if(launcherClosed)throw Error('Preview exited before readiness: '+output);return output.includes('Foreground preview: Ctrl-C stops only these owned children');},90000);
 return JSON.parse(readFileSync(path.join(runtime,'state.json'),'utf8'));
}
async function stop(){
 if(!started)return;
 if(!launcherClosed){launcherChild.kill('SIGINT');await until(()=>launcherClosed,20000);}
 // Foreground launcher owns and waits for both children before deleting state.
 assert(!existsSync(path.join(runtime,'state.json')),'Preview cleanup incomplete; retain state and do not start another preview');started=false;
}
function sql(query,params=[],{venue=false}={}){
 const file=path.join(runtime,venue?'execution-venue.sqlite3':'preview.sqlite3');
 return JSON.parse(execFileSync(python,['-c',`import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row\nprint(json.dumps([dict(r) for r in c.execute(sys.argv[2],json.loads(sys.argv[3]))]))`,file,query,JSON.stringify(params)],{encoding:'utf8'}));
}
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('Bounded linked preview condition timed out');}
async function closeMobileNavigation(page,width){
 if(width>=1024)return;
 const trigger=page.getByRole('button',{name:'Open navigation',exact:true});
 await trigger.waitFor();
 if(await trigger.getAttribute('aria-expanded')==='true')await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.getElementById('console-sidebar')?.getBoundingClientRect().right<=1);
}
async function shot(page,name){const file=path.join(evidence,`${name}.png`);await page.screenshot({path:file,fullPage:true});receipt.screenshots.push(path.basename(file));save();}
async function login(base,name){
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort('blockedbyclient'));
 await context.routeWebSocket('**/*',socket=>socket.close());
 const page=await context.newPage();page.setDefaultTimeout(30000);
 await page.goto(base+'/login?redirectTo=/console/profile/preferences');
 await page.getByLabel('Email Address',{exact:true}).fill(name+'@stage01.example.com');
 await page.getByLabel('Password',{exact:true}).fill('SyntheticPreview123!');
 await page.getByRole('button',{name:'Sign In',exact:true}).click();
 await page.waitForURL(base+'/console/profile/preferences');
 await page.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).waitFor();
 return {context,page};
}
async function enable(page){
 const box=page.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true});assert.equal(await box.isChecked(),false);
 const saved=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname.endsWith('/me/modules'));
 await box.click();assert.equal((await saved).status(),200);await until(()=>box.isChecked());
}
async function analyze(page,base,owner){
 const count=()=>sql('SELECT count(*) n FROM auto_rebalance_workflows WHERE user_id=?',[owner])[0].n;
 const before=count();
 await page.goto(base+'/console/automated-rebalance');
 await page.getByRole('heading',{name:'Choose your research workspace',exact:true}).waitFor();
 assert.equal(count(),before,'Legacy navigation must not start research');
 const source=await page.evaluate(async()=>{
  const response=await fetch('/backend-api/runs/analysis-workflows/synthetic-source',{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({portfolio:'india'})});
  return {status:response.status,body:await response.json()};
 });
 assert.equal(source.status,200);assert.equal(source.body.owner_id,owner);
 assert.equal(source.body.simulation_only,true);assert.match(source.body.source_hash,/^[a-f0-9]{64}$/);
 receipt.checks.push('explicit_owned_synthetic_source_after_module_selection');save();
 const setupResponse=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname==='/backend-api/runs/analysis-workflows/setup-context'&&new URL(r.url()).searchParams.get('portfolio')==='india');
 await page.getByRole('link',{name:'Open Zerodha Rebalance research',exact:true}).click();
 const setupHTTP=await setupResponse;assert.equal(setupHTTP.status(),200);const setup=await setupHTTP.json();
 assert.equal(setup.owner_id,owner);assert.equal(setup.portfolio,'india');assert.equal(setup.orders_authorized,false);
 assert.match(setup.source_hash,/^[a-f0-9]{64}$/);assert.match(setup.plan_hash,/^[a-f0-9]{64}$/);
 await page.waitForURL(base+'/console/zerodha/research');
 await page.getByRole('heading',{name:'Research setup',exact:true}).waitFor();
 const region=page.getByRole('region',{name:'Server analysis'});
 assert.equal(await region.getByRole('combobox').count(),0,'Portfolio is bound by the module, not a mutable selector');
 const start=region.getByRole('button',{name:'Start research',exact:true});
 await start.waitFor();assert.equal(await start.isEnabled(),false,'Unreviewed setup cannot start');
 await page.getByLabel(/^Candidate source/).selectOption('combined');
 await page.getByLabel('Candidate symbols or CSV',{exact:true}).fill('SYNTHETIC0\nSYNTHETIC0');
 await page.getByLabel('Minimum cash reserve',{exact:true}).fill('10.00');
 await page.getByRole('checkbox',{name:/I accept a maximum of 200/}).check();
 const optionsResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/backend-api/runs/analysis-workflows/options-preview');
 await page.getByRole('button',{name:'Preview research inputs',exact:true}).click();
 const optionsHTTP=await optionsResponse;assert.equal(optionsHTTP.status(),200);const preview=await optionsHTTP.json();
 assert.equal(preview.owner_id,owner);assert.equal(preview.source_hash,setup.source_hash);assert.equal(preview.options.mode,'combined');assert.equal(preview.options.discovery_receipt.live_provider_called,false);
 assert.equal(preview.options.coverage.shortlist_rows,2);assert.equal(preview.options.coverage.unique_candidates,1);assert.equal(preview.options.coverage.holdings_overlap,1);
 for(const width of [320,390,768,1280,1440]){
  await page.setViewportSize({width,height:844});
  await closeMobileNavigation(page,width);
  const geometry=await page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth}));
  assert.ok(geometry.page<=geometry.viewport+1,`Research options overflow at ${width}px`);
  await shot(page,`owner-${owner}-research-options-${width}px`);
 }
 const consent=page.getByRole('checkbox',{name:/I reviewed this exact source, candidate coverage, constraints and usage/});
 await consent.check();await until(()=>start.isEnabled());
 assert.equal(count(),before,'Source acquisition and setup consent must not start research');
 const posted=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/backend-api/runs/analysis-workflows');
 await start.click();const body=(await posted).postDataJSON();
 assert.equal(body.portfolio,'india');assert.equal(body.expected_source_hash,setup.source_hash);assert.equal(body.expected_plan_hash,setup.plan_hash);assert.equal(body.expected_module_version,setup.module_version);assert.equal(body.snapshot_id,setup.snapshot_id);
 assert.equal(body.research_setup.setup_hash,preview.setup_hash);assert.equal(body.research_setup.mode,'combined');assert.equal(body.research_setup.constraints.minimum_cash,'10.00');
 await region.getByRole('heading',{name:/^Research \d+ · Research completed$/}).waitFor({timeout:90000});
 const flow=sql("SELECT id FROM auto_rebalance_workflows WHERE user_id=? AND portfolio='india' AND status='completed' ORDER BY id DESC LIMIT 1",[owner])[0];assert(flow);
 assert.equal(count(),before+1,'One deliberate start creates exactly one owned workflow');
 const frozen=JSON.parse(sql('SELECT execution_json FROM auto_rebalance_workflows WHERE id=?',[flow.id])[0].execution_json);
 assert.equal(frozen.source_hash,body.expected_source_hash);assert.equal(frozen.plan_hash,body.expected_plan_hash);
 assert.equal(frozen.research_setup_hash,preview.setup_hash);assert.equal(frozen.research_setup.discovery_performed,true);
 const stages=sql('SELECT stage,status FROM auto_rebalance_workflow_stages WHERE workflow_id=?',[flow.id]);
 assert.equal(stages.length,6);assert(stages.every(s=>s.status==='completed'));
 const spend=sql('SELECT status,actual_usd,request_hash FROM recommendation_spend_attempts WHERE user_id=?',[owner]);
 assert.equal(spend.length,5);assert(spend.every(s=>s.status==='settled'&&s.actual_usd!==null&&Number(s.actual_usd)===0&&/^[a-f0-9]{64}$/.test(s.request_hash)));
 await shot(page,`owner-${owner}-six-stage-analysis`);
 receipt.checks.push('canonical_module_setup_explicit_consent_one_start_six_stage_completion');save();
 const row=await until(()=>sql("SELECT id,state,review_digest,approved_at,account_id,app_mode,connection_version,payload_json FROM confirmed_order_intents WHERE owner_id=? ORDER BY created_at DESC LIMIT 1",[owner])[0]);
 assert.equal(row.state,'awaiting_approval');assert.equal(row.approved_at,null);assert.match(row.review_digest,/^[a-f0-9]{64}$/);
 assert.equal(sql('SELECT count(*) n FROM order_execution_attempts WHERE intent_id=?',[row.id])[0].n,0);
 await page.goto(base+'/console/profile/activity');
 await page.getByRole('button',{name:'Refresh recorded order status',exact:true}).click();
 const card=page.getByRole('article',{name:'Order '+row.id});await card.getByText('awaiting approval',{exact:true}).waitFor();
 const payload=JSON.parse(row.payload_json);
 assert.deepEqual(payload,{sequencing:'listed',legs:[{exchange:'NSE',symbol:'SYNTHETIC0',side:'SELL',quantity:2,limit_price:'10.01',product:'CNC',order_type:'LIMIT'}]});
 const legs=card.getByRole('list',{name:'Exact persisted basket instructions'}).getByRole('listitem');
 assert.equal(await legs.count(),1);await legs.first().getByText(/SELL 2 NSE:SYNTHETIC0 · LIMIT ₹10.01 · CNC/).waitFor();
 const mode=row.app_mode==='user_owned'?'Your Kite app':'CredX-managed Kite app';
 await card.getByText(`Intent ${row.id} · Account ••••${row.account_id.slice(-2)} · ${mode} · connection version ${row.connection_version}`,{exact:true}).waitFor();
 await shot(page,`owner-${owner}-exact-unapproved-review`);
 return {row,card,flow};
}
async function approve(page,row,card){
 const approvals=[];const observe=r=>{if(r.url().endsWith(`/order-intents/${row.id}/approve`)&&r.method()==='POST')approvals.push(r);};page.on('request',observe);
 try{
 assert.equal(await card.getByRole('button',{name:'Confirm simulated orders',exact:true}).count(),0);
 await card.getByRole('button',{name:'Review exact simulated orders',exact:true}).click();
 assert.equal(approvals.length,0,'Opening exact review is not consent or dispatch');
 assert.equal(sql('SELECT approved_at FROM confirmed_order_intents WHERE id=?',[row.id])[0].approved_at,null);
 const request=page.waitForRequest(r=>r.url().endsWith(`/order-intents/${row.id}/approve`)&&r.method()==='POST');
 await card.getByRole('button',{name:'Confirm simulated orders',exact:true}).click();
 assert.deepEqual((await request).postDataJSON(),{displayed_digest:row.review_digest,action:'confirm_exact_order_or_basket'});
 assert.equal(approvals.length,1);
 }finally{page.off('request',observe);}
}
function venueCount(){return sql('SELECT count(*) n FROM synthetic_venue_orders',[],{venue:true})[0].n;}
async function refreshAfterRestart(page,origin,intentId,state){
 // Restart can invalidate an in-flight pooled read. Wait on authenticated GETs,
 // then use the UI's documented refresh action. Never retry approval/dispatch.
 await until(async()=>{try{const response=await page.request.get(origin+'/backend-api/order-intents/reviews',{timeout:5000,maxRedirects:0});return response.ok();}catch{return false;}},30000);
 await page.reload({waitUntil:'domcontentloaded',timeout:15000});
 const card=page.getByRole('article',{name:'Order '+intentId});
 for(let attempt=0;attempt<3;attempt++){
  await page.getByRole('button',{name:'Refresh recorded order status',exact:true}).click();
  try{await card.getByRole('heading',{name:state,exact:true}).waitFor({timeout:5000});return card;}
  catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,500));}
 }
}

try{
 makeLauncher('partial');writeFileSync(path.join(evidence,'build.log'),command(['build'],600000));
 let state=await start('partial');const base=new URL(state.url).origin;
 const fingerprint=await (await fetch(base+'/api/runtime-fingerprint')).json();assert.equal(fingerprint.build_sha,sourceSha);receipt.served_fingerprint=fingerprint;
 browser=await chromium.launch({headless:true,env:{PATH:process.env.PATH,HOME:'/tmp'},...(process.env.STAGE18_CHROMIUM_PATH?{executablePath:process.env.STAGE18_CHROMIUM_PATH}:{})});
 const a=await login(base,'usera'),b=await login(base,'userb');
 const owners=Object.fromEntries(sql("SELECT username,id FROM users WHERE username IN ('usera','userb')").map(r=>[r.username,r.id]));
 await enable(a.page);await enable(b.page);
 const first=await analyze(a.page,base,owners.usera);
 await b.page.goto(base+'/console/profile/activity');
 await b.page.getByRole('button',{name:'Refresh recorded order status',exact:true}).click();
 await b.page.getByText('No persisted order intents in these account records.',{exact:false}).waitFor();
 assert.equal(await b.page.getByRole('article',{name:'Order '+first.row.id}).count(),0);
 assert.equal((await b.page.request.get(base+'/backend-api/order-intents/reviews/'+first.row.id)).status(),404);
 receipt.checks.push('real_login_two_owners_no_foreign_review','unapproved_analysis_creates_no_execution');save();
 await approve(a.page,first.row,first.card);
 await until(()=>sql('SELECT state FROM confirmed_order_intents WHERE id=?',[first.row.id])[0].state==='partial');
 await a.page.getByRole('button',{name:'Refresh recorded order status',exact:true}).click();
 await first.card.getByRole('heading',{name:'Unresolved: partial',exact:true}).waitFor();
 await first.card.getByText(/filled 1 of 2/).waitFor();assert.equal(venueCount(),1);
 await shot(a.page,'partial-ui-before-restart');await stop();state=await start('partial');
 const again=await refreshAfterRestart(a.page,base,first.row.id,'Unresolved: partial');assert.equal(venueCount(),1);
 assert.equal(sql('SELECT count(*) n FROM order_execution_attempts WHERE intent_id=?',[first.row.id])[0].n,1);
 await shot(a.page,'partial-ui-after-restart');receipt.checks.push('exact_http_approval_partial_ui_restart_no_replay');save();
 // Cancel a disable first, then actually disable. Neither action may resubmit.
 await a.page.goto(base+'/console/profile/preferences');const selection=a.page.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true});
 await selection.click();await a.page.getByRole('button',{name:'Keep selected',exact:true}).click();assert(await selection.isChecked());
 await selection.click();await a.page.getByRole('button',{name:'Confirm disable',exact:true}).click();await until(async()=>!await selection.isChecked());
 await a.page.goto(base+'/console/profile/activity');await a.page.getByRole('article',{name:'Order '+first.row.id}).waitFor();assert.equal(venueCount(),1);
 receipt.checks.push('cancelled_disable_preserves_selection_actual_disable_preserves_order_history');save();
 await a.page.goto(base+'/console/profile/privacy');
 await a.page.getByRole('heading',{name:'Your privacy requests',exact:true}).waitFor();
 await a.page.getByText('No privacy requests were returned in these account records.',{exact:true}).waitFor();
 await a.page.getByRole('button',{name:'Download partial account snapshot',exact:true}).click();
 await a.page.getByText('Account download is unavailable because its runtime inventory, storage or integrity could not be verified.',{exact:false}).waitFor();
 await a.page.getByRole('checkbox',{name:/I request a review of my account erasure options/}).check();
 const privacyResponse=a.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/backend-api/account/operations/privacy-requests');
 await a.page.getByRole('button',{name:'Record erasure-review request',exact:true}).click();
 const privacyHTTP=await privacyResponse;assert.equal(privacyHTTP.status(),200);const privacy=await privacyHTTP.json();
 assert.equal(privacy.owner_id,owners.usera);assert.equal(privacy.state,'retention_review_required');assert.equal(privacy.legal_approval,false);
 await a.page.getByRole('button',{name:'Cancel this review request',exact:true}).waitFor();
 await b.page.goto(base+'/console/profile/privacy');await b.page.getByText('No privacy requests were returned in these account records.',{exact:true}).waitFor();
 const cancelResponse=a.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/privacy-requests/'+privacy.id+'/cancel'));
 await a.page.getByRole('button',{name:'Cancel this review request',exact:true}).click();assert.equal((await cancelResponse).status(),200);
 await a.page.getByRole('heading',{name:'Erasure review · cancelled',exact:true}).waitFor();
 for(const width of [320,390,768,1280,1440]){
  await a.page.setViewportSize({width,height:844});
  await closeMobileNavigation(a.page,width);
  const geometry=await a.page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth}));
  assert.ok(geometry.page<=geometry.viewport+1,`Privacy utilities overflow at ${width}px`);await shot(a.page,`privacy-requests-${width}px`);
 }
 assert.equal(sql('SELECT count(*) n FROM users')[0].n,3);
 receipt.checks.push('owned_privacy_request_cancel_no_erasure_no_foreign_history','research_and_privacy_five_width_reflow');save();
 await stop();state=await start('after_acceptance');
 const second=await analyze(b.page,base,owners.userb);
 await approve(b.page,second.row,second.card);
 // Catch and persist the real durable unknown transition before restart; do not
 // pretend a browser screenshot necessarily caught this short-lived state.
 const unknown=await until(()=>{const r=sql('SELECT state,approved_at FROM confirmed_order_intents WHERE id=?',[second.row.id])[0];return r.state==='unknown'?r:null;});
 receipt.unknown_transition={intent:second.row.id,...unknown,observed_by:'read-only SQLite query',observed_at:new Date().toISOString()};save();
 await stop();assert.equal(sql('SELECT state FROM confirmed_order_intents WHERE id=?',[second.row.id])[0].state,'unknown','Unknown must remain durable after quiescent shutdown, not reconcile before restart');const countBefore=venueCount();assert.equal(countBefore,2);state=await start('after_acceptance');
 await until(()=>sql('SELECT state FROM confirmed_order_intents WHERE id=?',[second.row.id])[0].state==='filled');
 const reconciled=await refreshAfterRestart(b.page,base,second.row.id,'filled');
 await reconciled.getByText(/filled 2 of 2/).waitFor();
 assert.equal(venueCount(),countBefore);assert.equal(sql('SELECT count(*) n FROM order_execution_attempts WHERE intent_id=?',[second.row.id])[0].n,1);
 assert.equal(await reconciled.getByRole('button',{name:'Confirm simulated orders',exact:true}).count(),0);
 assert.equal(await reconciled.getByRole('button',{name:'Review exact simulated orders',exact:true}).count(),0);
 await shot(b.page,'unknown-restart-reconciled-ui');receipt.checks.push('accepted_unknown_durable_evidence_restart_filled_ui_one_venue_submission');
 receipt.passed=true;
}catch(error){
 receipt.error=String(error?.stack||error);
 // Capture only this disposable synthetic preview, before owned browser cleanup.
 for(const [ci,context] of (browser?.contexts()||[]).entries())for(const [pi,page] of context.pages().entries()){
  const name=`failure-context-${ci}-page-${pi}`;
  try{await page.screenshot({path:path.join(evidence,`${name}.png`),fullPage:true,timeout:5000});receipt.screenshots.push(`${name}.png`);}
  catch(diagnosticError){(receipt.diagnostic_errors??=[]).push(String(diagnosticError));}
  try{writeFileSync(path.join(evidence,`${name}.aria.txt`),await page.locator('body').ariaSnapshot({timeout:5000}));}
  catch(diagnosticError){(receipt.diagnostic_errors??=[]).push(String(diagnosticError));}
 }
 throw error;
}
finally{
 try{await browser?.close();}catch(error){receipt.passed=false;receipt.browser_cleanup_error=String(error);process.exitCode=1;}
 try{await stop();receipt.cleanup='Owned preview stop succeeded; synthetic databases retained';}catch(error){receipt.passed=false;receipt.cleanup_error=String(error);process.exitCode=1;}
 for(const name of ['backend.log','frontend.log']){const file=path.join(runtime,name);if(existsSync(file))writeFileSync(path.join(evidence,name),readFileSync(file));}
 save();
}
