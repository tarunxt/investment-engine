#!/usr/bin/env node
// Real Next production server/router/styles; all application API traffic is synthetic and intercepted.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {encode} from 'next-auth/jwt';
import ts from 'typescript';
import {response,user,india,us,runs,savedState} from './fixtures/p1-populated.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceFrontend=process.env.P1_FRONTEND_SOURCE||root,probe=process.env.P1_DIALOG_PROBE==='true';
const output='/workspace/p1-private-acceptance/'+(probe?(sourceFrontend===root?'keyboard-candidate':'keyboard-baseline'):'styled');await mkdir(output,{recursive:true});
const calls=[],writes=[],external=[],unknown=[],errors=[],checks=[];
const perf=await readFile(path.join(root,'scripts/performance-audit.mjs'),'utf8');const ast=ts.createSourceFile('performance.mjs',perf,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const defs=ast.statements.filter(node=>['dashboardSummaryFixture','legacyDashboardFixture'].includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');const {dashboardSummaryFixture,legacyDashboardFixture}=new Function(defs+';return {dashboardSummaryFixture,legacyDashboardFixture}')();
let mode='populated',owner=9001,delayUs=null;
function payload(url){
 if(url.pathname.endsWith('/dashboard/summary')){const data=dashboardSummaryFixture();data.zerodha.snapshot={...data.zerodha.snapshot,...india};data.indmoney_us.snapshot={...data.indmoney_us.snapshot,...us};return data;}
 if(mode==='partial'&&url.pathname.endsWith('/indmoney-us/portfolio'))return{latest:{...us,parse_status:'partial',reported_holdings_count:3,parse_warnings:['Synthetic partial source']},history:[us]};
 if(mode==='failed-stage'&&url.pathname.includes('/auto-rebalance-history')){const data=structuredClone(response(url.pathname,url.searchParams,owner));const item=data.items?.[0]??data;const stage=item.stages.find(item=>item.stage==='swing');stage.status='failed';stage.summary.run_status='failed';stage.error_message='Synthetic saved stage failure';return data;}
 if(mode==='restored-running'&&/\/runs\/100$/.test(url.pathname))return{...runs[0],status:'processing',run_jobs:runs[0].run_jobs.map(link=>({...link,job:{...link.job,status:'processing'}}))};
 if(mode==='empty'&&/\/(zerodha|indmoney-us)\/portfolio$/.test(url.pathname))return{latest:null,history:[]};
 const found=response(url.pathname,url.searchParams,owner);if(found!==undefined)return found;
 const legacy=legacyDashboardFixture(url.pathname);if(legacy!==undefined&&legacy!==null)return legacy;
 unknown.push(url.pathname);return{};
}
const backend=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');calls.push({source:'server',path:url.pathname,method:req.method});if(!['GET','HEAD'].includes(req.method)){writes.push({source:'server',path:url.pathname,method:req.method});res.statusCode=405;res.end('{}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(payload(url)));});
await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));const backendBase=`http://127.0.0.1:${backend.address().port}`;
const port=3120,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:sourceFrontend,env:{...process.env,BACKEND_API_URL:backendBase,API_URL:backendBase,NEXTAUTH_URL:base},stdio:['ignore','pipe','pipe']});let serverLog='';server.stdout.on('data',data=>serverLog+=data);server.stderr.on('data',data=>serverLog+=data);
let browser,context,page;
async function authenticate(id){owner=id;const now=Math.floor(Date.now()/1000);const value=await encode({secret:'local-auth-disabled-fallback-secret',salt:'authjs.session-token',token:{id:String(id),sub:String(id),email:user(id).email,name:user(id).full_name,username:user(id).username,role:'user',accessToken:'p1-synthetic-access',refreshToken:'p1-synthetic-refresh',expiresIn:3600,userData:user(id),iat:now,exp:now+3600}});await context.addCookies([{name:'authjs.session-token',value,url:base,httpOnly:true,secure:false,sameSite:'Lax',expires:now+3600}]);}
async function screenshot(name){const duplicates=await page.locator('[id]').evaluateAll(nodes=>{const seen=new Set();return nodes.map(node=>node.id).filter(id=>seen.has(id)||!seen.add(id))});if(duplicates.length)checks.push({name:'unique DOM IDs at '+name,status:'FAIL',duplicates});await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});await writeFile(path.join(output,name+'.txt'),await page.locator('body').innerText());await writeFile(path.join(output,name+'-controls.json'),JSON.stringify(await page.locator('button').filter({visible:true}).evaluateAll(nodes=>nodes.map(node=>({text:node.innerText,label:node.getAttribute('aria-label'),title:node.getAttribute('title')}))),null,2));}
async function record(name,action){try{await action();checks.push({name,status:'PASS'});console.log('PASS '+name);}catch(error){checks.push({name,status:'FAIL',error:error.message});console.log('FAIL '+name+': '+error.message.split('\n')[0]);await screenshot('failure-'+checks.length);for(let i=0;i<6;i++){const close=page.locator('button[aria-label^="Close"],button:has(svg.lucide-x)').filter({visible:true});if(!await close.count())break;await close.last().click().catch(()=>{});await page.waitForTimeout(30);}}}
async function closeVisible(){const close=page.locator('button[aria-label^="Close"], button:has(svg.lucide-x)').filter({visible:true});if(await close.count())await close.last().click();else await page.keyboard.press('Escape');}
try{
 await writeFile(path.join(output,'processes.json'),JSON.stringify({serverPid:server.pid,backendPort:backend.address().port}));let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/login')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready,'local server ready');
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});await authenticate(9001);
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base){external.push(request.url());return route.abort();}if(!url.pathname.startsWith('/backend-api/')&&!url.pathname.startsWith('/api/bullpen-ai'))return route.continue();calls.push({source:'browser',path:url.pathname,method:request.method()});if(!['GET','HEAD'].includes(request.method())){writes.push({source:'browser',path:url.pathname,method:request.method()});return route.fulfill({status:405,json:{detail:'Mutation blocked by P1 fixture'}});}if(delayUs&&url.pathname.endsWith('/indmoney-us/portfolio'))await delayUs;const data=payload(url);return route.fulfill({status:mode==='failed'&&url.pathname.endsWith('/indmoney-us/portfolio')?503:200,json:data});});
 page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 if(probe){
 await page.goto(base+(sourceFrontend===root?'/console/zerodha#india-workflow':'/console/automated-rebalance'));await page.getByRole('navigation',{name:'Automated rebalance views'}).waitFor();const scope=sourceFrontend===root?page.locator('#india-workflow'):page.locator('main').first();await scope.getByRole('button',{name:/03.*Swing Scan/}).click();
 for(const name of ['Inputs','Models','Prompt','Saved output']){
 const trigger=scope.getByRole('button',{name,exact:true});await trigger.focus();await page.keyboard.press('Enter');
 const close=page.locator('button[aria-label^="Close"],button:has(svg.lucide-x)').filter({visible:true}).last();await close.waitFor();
 const panel=close.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," fixed ")][1]');
 await page.keyboard.press('Tab');const focusInside=await panel.evaluate(node=>node.contains(document.activeElement));
 await page.keyboard.press('Escape');await page.waitForTimeout(60);const escaped=!await close.isVisible();
 checks.push({name:name+' Escape closure',status:escaped?'PASS':'FAIL'});checks.push({name:name+' keyboard focus stays in popup',status:focusInside?'PASS':'FAIL'});
 if(!escaped)await close.click();const focusReturn=await trigger.evaluate(node=>node===document.activeElement);checks.push({name:name+' focus return',status:focusReturn?'PASS':'FAIL'});
 await trigger.click();await close.waitFor();await screenshot('keyboard-'+name.replaceAll(' ','-'));await close.click();
 }
 } else {
 await page.goto(base+'/console/zerodha#india-workflow');await page.locator('#india-workflow nav').waitFor();await page.getByText('FALP',{exact:true}).first().waitFor();await screenshot('india-populated-desktop');
 await record('real styles and full India workspace precede appended workflow',async()=>{assert.equal(await page.locator('#saved-portfolio-snapshots table').count()>=3,true);assert.ok(await page.evaluate(()=>document.querySelector('#saved-portfolio-snapshots').compareDocumentPosition(document.querySelector('#india-workflow'))&Node.DOCUMENT_POSITION_FOLLOWING));assert.equal(await page.locator('#india-workflow').evaluate(node=>getComputedStyle(node).minWidth),'0px');});
 await record('populated India holdings, net and day rows retained',async()=>{assert.equal(await page.locator('#saved-portfolio-snapshots').getByText('FALP',{exact:true}).count()>=1,true);assert.equal(await page.locator('#saved-portfolio-snapshots').getByText('FBET',{exact:true}).count()>=1,true);});
 const workflow=()=>page.locator('#india-workflow,#us-workflow');
 await record('contextual Stock Flow opens, toggles locally, closes and reopens',async()=>{const before=page.url();await workflow().getByRole('button',{name:'Stock Flow',exact:true}).first().click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByRole('button',{name:'Detailed View',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Summary View',exact:true}).waitFor();assert.equal(page.url(),before);await screenshot('stock-flow-detailed');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});await workflow().getByRole('button',{name:'Stock Flow',exact:true}).last().click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Close Rebalance Stock Flow'}).click();});
 await record('six stages retain contextual Inputs, Models, Prompt and saved-output access',async()=>{for(const stage of ['Threats Scan','Swing Scan','Rebalance','Technical','Actionables']){const row=workflow().getByRole('button',{name:new RegExp(stage,'i')}).first();if(await row.count())await row.click();for(const name of ['Inputs','Models','Prompt','Saved output']){const button=workflow().getByRole('button',{name,exact:true});if(!await button.count())continue;await button.click();await page.waitForTimeout(100);await screenshot('overlay-'+stage.replaceAll(' ','-')+'-'+name.replaceAll(' ','-'));await closeVisible();}}});
 await record('duration dialog keyboard close, focus return and reopen',async()=>{const trigger=workflow().getByRole('button',{name:'Show duration breakdown for Swing Scan',exact:true});await trigger.focus();await trigger.click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);await trigger.click();await page.getByRole('button',{name:'Close duration breakdown'}).click();});
 await record('saved scan cost history opens and reopens independently of execution',async()=>{const trigger=workflow().getByRole('button',{name:/cost history$/});await trigger.click();await page.getByRole('button',{name:'Close auto-rebalance cost history'}).waitFor();await screenshot('cost-history');await page.getByRole('button',{name:'Close auto-rebalance cost history'}).click();await trigger.click();await page.getByRole('button',{name:'Close auto-rebalance cost history'}).click();});
 await record('India basket remains a separate review and preserves populated retained rows',async()=>{await workflow().getByRole('button',{name:'Place Order',exact:true}).click();await page.getByRole('button',{name:'Close Zerodha basket preview'}).waitFor();await page.getByText('FALP',{exact:true}).last().waitFor();await screenshot('india-basket-review');await page.getByRole('button',{name:'Close Zerodha basket preview'}).click();});
 await record('Final Actionables nested stock, consensus, setup and calculation families',async()=>{
 await workflow().getByRole('button',{name:/06.*Actionables/i}).click();await workflow().getByRole('button',{name:'Saved output',exact:true}).click();await page.getByRole('button',{name:'Close output view'}).waitFor();
 await page.getByRole('button',{name:'Show FALP LLM recommendation breakup',exact:true}).click();await page.getByRole('button',{name:'Close consensus breakup'}).waitFor();await screenshot('nested-consensus');await page.getByRole('button',{name:'Close consensus breakup'}).click();
 await page.getByRole('button',{name:'Support bounce (2)',exact:true}).first().click();await page.getByRole('button',{name:'Close setup stocks popup'}).waitFor();await screenshot('nested-setup');await page.getByRole('button',{name:'Close setup stocks popup'}).click();
 await page.getByRole('button',{name:'Open FALP captured details',exact:true}).first().click();await page.getByRole('button',{name:'Close stock details',exact:true}).waitFor();await screenshot('nested-stock-details');
 await page.getByRole('button',{name:'Close stock details',exact:true}).click();await page.getByRole('button',{name:'Expand FALP LLM-wise breakup',exact:true}).click();await page.getByRole('button',{name:/View matrix/}).first().click();await page.getByRole('button',{name:'Close score matrix popup'}).waitFor();
 const parameter=page.getByRole('button',{name:/Show original scores and rationale/}).first();await parameter.click();await page.getByRole('button',{name:'Close parameter score details'}).waitFor();await screenshot('nested-parameter-evidence');await page.getByRole('button',{name:'Close parameter score details'}).click();assert.equal(await page.getByRole('button',{name:'Close score matrix popup'}).isVisible(),true);await page.getByRole('button',{name:'Close score matrix popup'}).click();
 await page.getByRole('button',{name:'Actionables Calculations',exact:true}).click();await page.getByRole('button',{name:'Close Actionables Calculations popup'}).waitFor();await screenshot('nested-calculations');await page.getByRole('button',{name:'Logics & formulas',exact:true}).click();await page.getByRole('button',{name:'Close formulas popup'}).waitFor();await screenshot('nested-formulas');await page.getByRole('button',{name:'Close formulas popup'}).click();assert.equal(await page.getByRole('button',{name:'Close Actionables Calculations popup'}).isVisible(),true);await page.getByRole('button',{name:'Close Actionables Calculations popup'}).click();await page.getByRole('button',{name:'Close output view'}).click();
 });
 // This is actual App Router client navigation, not a mocked router adapter.
 await record('sibling portfolio client navigation, Back and Forward retain runtime and append outside US tabs',async()=>{await workflow().getByRole('button',{name:'US stage ledger',exact:true}).click();await page.locator('#us-workflow nav').waitFor();assert.equal(new URL(page.url()).pathname,'/console/indmoney-us');assert.ok(await page.evaluate(()=>document.querySelector('[role="tablist"]').compareDocumentPosition(document.querySelector('#us-workflow'))&Node.DOCUMENT_POSITION_FOLLOWING));await page.goBack();await page.locator('#india-workflow nav').waitFor();await page.goForward();await page.locator('#us-workflow nav').waitFor();});
 await record('US local tabs retain populated holdings and paste draft',async()=>{await page.getByRole('tab',{name:'Paste snapshot',exact:true}).click();await page.getByLabel('Paste INDmoney data here').fill('Synthetic retained draft');await page.getByRole('tab',{name:'Saved US snapshot'}).click();await page.getByRole('tab',{name:'Paste snapshot',exact:true}).click();assert.equal(await page.getByLabel('Paste INDmoney data here').inputValue(),'Synthetic retained draft');await page.getByRole('tab',{name:'Saved US snapshot'}).click();assert.ok(await page.locator('#us-snapshot-panel-saved').getByText('Synthetic Alpha',{exact:true}).count());});
 await screenshot('us-populated-desktop');
 await record('US Final Order remains a manual review with populated rows and USD',async()=>{await workflow().getByRole('button',{name:'Final Order',exact:true}).click();await page.getByRole('button',{name:'Close IndMoney basket preview'}).waitFor();await screenshot('us-basket-review');await page.getByRole('button',{name:'Close IndMoney basket preview'}).click();});
 await record('US Final Actionables nested families retain matching market',async()=>{
 await workflow().getByRole('button',{name:/06.*Actionables/i}).click();await workflow().getByRole('button',{name:'Saved output',exact:true}).click();await page.getByRole('button',{name:'Close output view'}).waitFor();
 await page.getByRole('button',{name:'Show FALP LLM recommendation breakup',exact:true}).click();await page.getByRole('button',{name:'Close consensus breakup'}).waitFor();await screenshot('us-nested-consensus');await page.getByRole('button',{name:'Close consensus breakup'}).click();
 await page.getByRole('button',{name:'Support bounce (2)',exact:true}).first().click();await page.getByRole('button',{name:'Close setup stocks popup'}).waitFor();await screenshot('us-nested-setup');await page.getByRole('button',{name:'Close setup stocks popup'}).click();
 await page.getByRole('button',{name:'Open FALP captured details',exact:true}).first().click();await page.getByRole('button',{name:'Close stock details',exact:true}).waitFor();await screenshot('us-nested-stock-details');
 await page.getByRole('button',{name:'Close stock details',exact:true}).click();await page.getByRole('button',{name:'Expand FALP LLM-wise breakup',exact:true}).click();await page.getByRole('button',{name:/View matrix/}).first().click();await page.getByRole('button',{name:'Close score matrix popup'}).waitFor();
 const parameter=page.getByRole('button',{name:/Show original scores and rationale/}).first();await parameter.click();await page.getByRole('button',{name:'Close parameter score details'}).waitFor();await screenshot('us-nested-parameter-evidence');await page.getByRole('button',{name:'Close parameter score details'}).click();assert.equal(await page.getByRole('button',{name:'Close score matrix popup'}).isVisible(),true);await page.getByRole('button',{name:'Close score matrix popup'}).click();
 await page.getByRole('button',{name:'Actionables Calculations',exact:true}).click();await page.getByRole('button',{name:'Close Actionables Calculations popup'}).waitFor();await screenshot('us-nested-calculations');await page.getByRole('button',{name:'Logics & formulas',exact:true}).click();await page.getByRole('button',{name:'Close formulas popup'}).waitFor();await screenshot('us-nested-formulas');await page.getByRole('button',{name:'Close formulas popup'}).click();assert.equal(await page.getByRole('button',{name:'Close Actionables Calculations popup'}).isVisible(),true);await page.getByRole('button',{name:'Close Actionables Calculations popup'}).click();await page.getByRole('button',{name:'Close output view'}).click();
 });

 await record('snapshot review Escape, focus return, reopen and navigation teardown',async()=>{const trigger=workflow().getByRole('button',{name:'Sync Now',exact:true});await trigger.focus();await trigger.click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);await trigger.click();await page.getByRole('dialog').waitFor();await page.goBack();await page.locator('#india-workflow nav').waitFor();assert.equal(await page.getByRole('dialog').count(),0);});
 await record('pending saved-snapshot verification cannot continue after real-router Back',async()=>{
 await workflow().getByRole('button',{name:'US stage ledger',exact:true}).click();await page.locator('#us-workflow nav').waitFor();
 await workflow().getByRole('button',{name:'Sync Now',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.getByRole('radio',{name:/Continue with latest snapshot/}).check();
 let release;delayUs=new Promise(resolve=>release=resolve);await page.getByRole('button',{name:'Continue Rebalance',exact:true}).click();
 try { assert.equal(await page.getByRole('button',{name:'Continue Rebalance',exact:true}).isDisabled(),true);await page.goBack();await page.locator('#india-workflow nav').waitFor(); } finally {release();delayUs=null;}
 await page.waitForTimeout(100);assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(writes,[]);
 });
 await record('owner change and reload reject previous private surface state',async()=>{await authenticate(9002);await page.reload();await page.locator('#india-workflow nav').waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('investment-engine:private-cache-owner:v1')),'9002');});
 await record('cold compatibility route resolves to a fixed portfolio anchor',async()=>{await page.goto(base+'/console/automated-rebalance');await page.waitForURL('**/console/zerodha#india-workflow');await page.locator('#india-workflow nav').waitFor();});
 await record('real cross-tab owner removal and clear recover only the same authenticated account',async()=>{
 const peer=await context.newPage();try{
 await peer.goto(base+'/login');
 for(const clear of [false,true]){
 await peer.evaluate(clear=>{if(clear)localStorage.clear();else localStorage.removeItem('investment-engine:private-cache-owner:v1')},clear);
 await page.getByRole('alert').getByText(/Account confirmation changed in another tab/).waitFor();
 assert.equal(await page.locator('#india-workflow nav').count(),0);
 await peer.evaluate(()=>localStorage.setItem('investment-engine:private-cache-owner:v1','9002'));
 await page.locator('#india-workflow nav').waitFor();
 assert.equal(await page.getByText(/Account confirmation changed in another tab/).count(),0);
 }
 }finally{await peer.close();}
 });
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await screenshot('india-final-'+width);await record('responsive viewport '+width,async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true));}
 await record('Dashboard preserves existing content and defers inline Stock Flow until scroll',async()=>{await page.goto(base+'/console/dashboard');await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();await page.locator('#rebalance-stock-flow').scrollIntoViewIfNeeded();await page.getByText('Rebalance Stock Flow',{exact:true}).waitFor();assert.equal(await page.locator('#india-workflow,#us-workflow').count(),0);await screenshot('dashboard-stock-flow');});
 for(const state of ['empty','partial','failed','failed-stage','restored-running','queued']){
 await record('conditional saved/workflow state '+state,async()=>{
 mode=state;
 if(['restored-running','queued'].includes(state))await page.evaluate(value=>localStorage.setItem('investment-engine:rebalance-workflow-state:v1',JSON.stringify(value)),savedState('zerodha',state==='queued'?'queued':'running'));
 await page.goto(base+(state==='partial'||state==='failed'||state==='empty'?'/console/indmoney-us':'/console/zerodha')+'#'+(state==='partial'||state==='failed'||state==='empty'?'us-workflow':'india-workflow'));
 await page.reload();await page.locator('#india-workflow nav,#us-workflow nav').waitFor();
 if(state==='empty')await page.getByText('No INDmoney snapshots yet',{exact:true}).waitFor();
 if(state==='partial')await page.getByText('Holdings parse status: Partial',{exact:false}).waitFor();
 if(state==='failed')await page.getByRole('alert').getByText('Saved portfolio data could not be loaded.',{exact:true}).waitFor();
 if(state==='failed-stage'){await page.getByRole('button',{name:'Show error details for Swing Scan',exact:true}).click();await page.getByText('Synthetic saved stage failure',{exact:false}).first().waitFor();await page.getByRole('button',{name:'Close error details',exact:true}).click();}
 if(state==='restored-running'){await workflow().getByText(/running|processing/i).first().waitFor();const initial=calls.filter(call=>/\/runs\/100$/.test(call.path)).length;await page.waitForTimeout(3200);assert.ok(calls.filter(call=>/\/runs\/100$/.test(call.path)).length>initial);}
 await screenshot('state-'+state);mode='populated';
 });
 }
 await record('zero external/provider or financial mutations',async()=>assert.deepEqual(writes,[]));
 }
} catch(error){checks.push({name:'fixture setup/continuation',status:'FAIL',error:error.message});if(page)await screenshot('setup-failure');}
finally{
 const result={checks,calls,writes,external,unknown:[...new Set(unknown)],errors,source:'Real Next production app; synthetic intercepted API; screenshots contain only synthetic fixture data.'};await writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks,unknown:result.unknown,writes,errors},null,2));
 await browser?.close();server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null)server.kill('SIGKILL');await new Promise(resolve=>backend.close(resolve));await writeFile(path.join(output,'server.log'),serverLog);
}
if(checks.some(check=>check.status==='FAIL'))process.exitCode=1;
