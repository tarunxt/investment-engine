#!/usr/bin/env node
/** Disposable real-rendered navigation qualification. No deployment/provider adapters. */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const runtime=path.join(root,'.runtime/stage01-preview');
const evidence=path.resolve(process.env.SIDEBAR_BROWSER_EVIDENCE||'/tmp/credx-sidebar-browser');
const python=process.env.LINKED_BROWSER_PYTHON||'python';
const launcher=path.join(root,'scripts/public_launch/preview.py');
assert(!existsSync(runtime),'Fresh disposable checkout required');
for(const directory of [root,path.join(root,'frontend')])for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert(!existsSync(path.join(directory,name)),'Inherited app environment refused');
mkdirSync(evidence,{recursive:true});
const receipt={source_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),passed:false,scope:'Local real-rendered sidebar, synthetic account/SQLite, no orders or providers',checks:[],screenshots:[],deployed_verified:false};
const save=()=>writeFileSync(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');save();
let child,closed=false,browser;
async function until(fn,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Bounded sidebar preview condition timed out');}
try{
 writeFileSync(path.join(evidence,'build.log'),execFileSync(python,[launcher,'build'],{cwd:root,encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024}));
 let output='';child=spawn(python,['-u',launcher,'start','--foreground'],{cwd:root,stdio:['ignore','pipe','pipe']});child.once('close',()=>closed=true);
 const collect=data=>{output+=data;writeFileSync(path.join(evidence,'startup.log'),output);};child.stdout.on('data',collect);child.stderr.on('data',collect);
 await until(()=>{if(closed)throw Error('Owned preview exited before readiness');return output.includes('Foreground preview: Ctrl-C stops only these owned children');});
 const state=JSON.parse(readFileSync(path.join(runtime,'state.json'),'utf8'));const base=new URL(state.url).origin;
 const fingerprint=await(await fetch(base+'/api/runtime-fingerprint')).json();assert.equal(fingerprint.build_sha,receipt.source_sha);receipt.served_fingerprint=fingerprint;
 browser=await chromium.launch({headless:true,env:{PATH:process.env.PATH,HOME:'/tmp'},...(process.env.STAGE18_CHROMIUM_PATH?{executablePath:process.env.STAGE18_CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 await context.route('**/*',route=>{const url=route.request().url();return url.startsWith(base+'/')?route.continue():route.abort();});await context.routeWebSocket('**/*',socket=>socket.close());
 const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.goto(base+'/login?redirectTo=/console/profile/preferences');await page.getByLabel('Email Address',{exact:true}).fill('usera@stage01.example.com');await page.getByLabel('Password',{exact:true}).fill('SyntheticPreview123!');await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.waitForURL(base+'/console/profile/preferences');
 const workspace=page.getByRole('navigation',{name:'Workspace',exact:true});
 await page.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).waitFor();
 assert.equal(await workspace.getByRole('link',{name:'Zerodha Rebalance',exact:true}).count(),0);assert.equal(await workspace.getByRole('link',{name:'INDmoney US',exact:true}).count(),0);
 receipt.checks.push('zero_module_keeps_core_and_visible_account_without_optional_links');
 for(const name of ['Select Zerodha Rebalance','Select INDmoney US']){const box=page.getByRole('checkbox',{name,exact:true});assert.equal(await box.isChecked(),false);const response=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.endsWith('/me/modules'));void response.catch(()=>{});await box.click();assert.equal((await response).status(),200);await until(()=>box.isChecked());}
 await page.goto(base+'/console/zerodha');await workspace.getByRole('link',{name:/Zerodha Rebalance/}).waitFor();
 assert.equal(await workspace.getByRole('link',{name:/Zerodha Rebalance/}).getAttribute('aria-current'),'page');assert.equal(await workspace.getByRole('link',{name:'INDmoney US',exact:true}).count(),1);
 const account=page.getByRole('region',{name:'Your account',exact:true});
 // The account area is a labelled section (region); Profile and Preferences are direct links.
 await account.getByRole('link',{name:'Profile',exact:true}).waitFor();await account.getByRole('link',{name:'Preferences',exact:true}).waitFor();
 for(const width of [1440,1280,768,390,320]){
  await page.setViewportSize({width,height:1000});await page.evaluate(()=>scrollTo(0,0));
  if(width<1024){const trigger=page.getByRole('button',{name:'Open navigation',exact:true});await trigger.click();await page.getByRole('dialog',{name:'Workspace navigation',exact:true}).waitFor();assert.equal(await trigger.getAttribute('aria-expanded'),'true');
   // Browser keyboard focus must wrap inside the real drawer and Escape restores its trigger.
   await page.getByRole('button',{name:'Close navigation',exact:true}).focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.getElementById('console-sidebar')?.contains(document.activeElement)),true);
  }
  const geometry=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,sidebar:document.getElementById('console-sidebar')?.getBoundingClientRect().width}));assert.ok(geometry.page<=width+1);assert.ok(geometry.sidebar<=width);
  const name=`sidebar-${width}px.png`;await page.screenshot({path:path.join(evidence,name)});receipt.screenshots.push(name);
  if(width<1024){await page.keyboard.press('Escape');await until(()=>page.getByRole('button',{name:'Open navigation',exact:true}).getAttribute('aria-expanded').then(x=>x==='false'));assert.equal(await page.getByRole('button',{name:'Open navigation',exact:true}).evaluate(el=>el===document.activeElement),true);}
 }
 receipt.checks.push('five_width_sidebar_reflow','mobile_focus_wrap_escape_restore','selected_module_active_icons_and_account_discoverability');
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/console/profile/preferences');
 const response=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/auth/profile'));void response.catch(()=>{});
 await page.getByRole('button',{name:'Dark',exact:true}).click();assert.equal((await response).status(),200);await until(()=>page.locator('html').getAttribute('class').then(x=>x?.includes('dark')));
 await page.screenshot({path:path.join(evidence,'sidebar-dark.png')});receipt.screenshots.push('sidebar-dark.png');
 const restore=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/auth/profile'));void restore.catch(()=>{});await page.getByRole('button',{name:'Light',exact:true}).click();assert.equal((await restore).status(),200);
 receipt.checks.push('synthetic_dark_light_controls_and_restore');receipt.passed=true;save();await context.close();
}catch(error){receipt.error=String(error.stack||error);save();throw error;}
finally{if(browser)await browser.close();if(child&&!closed){child.kill('SIGINT');await until(()=>closed,20000);}receipt.cleanup=existsSync(path.join(runtime,'state.json'))?'incomplete; retain owned fixture':'Owned preview stopped; synthetic evidence retained';save();}
