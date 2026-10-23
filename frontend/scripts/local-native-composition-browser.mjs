/** Disposable installed-composition UI qualification; never hosted evidence. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.LOCAL_NATIVE_BROWSER_URL,sha=process.env.LOCAL_NATIVE_BROWSER_SHA;
assert(base&&/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base));assert.match(sha,/^[a-f0-9]{40}$/);
const output=process.env.LOCAL_NATIVE_BROWSER_EVIDENCE;assert(output?.startsWith('/tmp/'));
mkdirSync(output,{recursive:true});
const receipt={source_sha:sha,kind:'local_native_composition_ui',passed:false,sqlite:true,
 postgresql:false,redis:false,hosted:false,google_signin_verified:false,checks:[],screenshots:[]};
const browser=await chromium.launch({headless:true});let context,page;
async function shot(page,name){await page.screenshot({path:output+'/'+name+'.png',fullPage:true});receipt.screenshots.push(name+'.png');}
try{
 context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===base)return route.continue();(receipt.blocked_urls??=[]).push(u.origin+u.pathname);return route.abort('blockedbyclient');});
 await context.routeWebSocket('**/*',socket=>socket.close());
 page=await context.newPage();page.setDefaultTimeout(45000);page.on('requestfailed',request=>{const u=new URL(request.url());(receipt.failed_requests??=[]).push({url:u.origin+u.pathname,error:request.failure()?.errorText});});
 await page.goto(base+'/login?redirectTo=/console/uat2');
 await page.getByLabel('Email Address',{exact:true}).fill('usera@stage01.example.com');
 await page.getByLabel('Password',{exact:true}).fill('SyntheticPreview123!');
 await page.getByRole('button',{name:'Sign In',exact:true}).click();
 await page.waitForURL('**/console/uat2');
 await page.getByRole('heading',{name:'UAT2 owner simulation walkthrough',exact:true}).waitFor();
 await page.getByText('Build '+sha.slice(0,12),{exact:false}).waitFor();
 const area=page.locator('section').filter({has:page.getByRole('heading',{name:'Fake Kite connection and source',exact:true})}).last();
 await area.getByText('Only fake connections are available.',{exact:false}).waitFor();
 for(const label of ['managed','user-owned']){
  await area.getByRole('button',{name:`Review ${label} Kite mode (fake)`,exact:true}).click();
  await area.getByRole('button',{name:'Confirm this simulated connection mode',exact:true}).click();
  await area.getByText('Fake connection recorded.',{exact:false}).waitFor();
  await area.getByRole('button',{name:'Acquire current fake India source',exact:true}).click();
  await area.getByText('Synthetic source acquired:',{exact:false}).waitFor();
  receipt.checks.push(label+'_keyless_connection_and_explicit_source');
 }
 await shot(page,'both-modes-source');
 async function start(portfolio){
  await page.getByRole('combobox',{name:/^Portfolio/}).selectOption(portfolio);
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/backend-api/runs/analysis-workflows');
  await page.getByRole('button',{name:'Start server analysis',exact:true}).click();
  const r=await response;assert.equal(r.status(),200);const flow=await r.json();
  const article=page.locator('article').filter({has:page.getByRole('heading',{name:`Workflow ${flow.id} · ${portfolio} · completed`,exact:true})});
  await article.waitFor({timeout:90000});return article;
 }
 const india=await start('india');
 await india.getByRole('button',{name:'Prepare exact fake basket review',exact:true}).click();
 await page.getByText('Synthetic review prepared.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Refresh recorded order status',exact:true}).click();
 await page.getByRole('button',{name:'I confirm this exact synthetic order / basket',exact:true}).click();
 for(let i=0;i<30;i++){
  await page.getByRole('button',{name:'Refresh recorded order status',exact:true}).click();
  if(await page.getByRole('heading',{name:'filled',exact:true}).count())break;
  await page.waitForTimeout(1000);
 }
 await page.getByRole('heading',{name:'filled',exact:true}).waitFor();
 await shot(page,'completed-analysis-exact-confirmation-filled');
 receipt.checks.push('native_ui_governed_analysis_exact_confirmation_and_fake_fill');
 await page.goto(base+'/console/indmoney-us');
 await page.getByRole('button',{name:'Manual INDmoney import · Preview and accept',exact:true}).click();
 await page.getByLabel('Source format',{exact:true}).selectOption('csv');
 await page.getByLabel('Holdings source',{exact:true}).fill('symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\nUATA,Synthetic Alpha,USD,2,55,100,110,10,10\n');
 await page.getByRole('button',{name:'Preview import',exact:true}).click();
 await page.getByRole('button',{name:'Accept this exact snapshot',exact:true}).click();
 await page.getByText('Validated snapshot accepted.',{exact:false}).waitFor();
 await shot(page,'exact-us-source-accepted');
 await page.goto(base+'/console/uat2');await start('indmoney_us');
 await shot(page,'us-six-stage-completed');
 receipt.checks.push('us_rendered_import_exact_acceptance_and_native_analysis');
 receipt.passed=true;
}catch(error){
 receipt.error=String(error);if(page){receipt.failure_url=page.url();receipt.failure_text=(await page.locator('body').innerText()).slice(0,16000);await shot(page,'failure');}throw error;
}finally{
 writeFileSync(output+'/receipt.json',JSON.stringify(receipt,null,2)+'\n');
 if(context)await context.close();await browser.close();
}
