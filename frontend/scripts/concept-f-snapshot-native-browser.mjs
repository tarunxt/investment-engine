/** Installed service composition on disposable SQLite; no native lifespan/hosted claim. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const base=process.env.LOCAL_NATIVE_BROWSER_URL,sha=process.env.LOCAL_NATIVE_BROWSER_SHA,output=process.env.LOCAL_NATIVE_BROWSER_EVIDENCE;
assert(base&&/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base));assert.match(sha,/^[a-f0-9]{40}$/);assert(output?.startsWith('/tmp/'));
mkdirSync(output,{recursive:true});const receipt={source_sha:sha,kind:'local_installed_composition_snapshot_review',passed:false,sqlite:true,postgresql:false,redis:false,hosted:false,checks:[],screenshots:[],writes:[]};
const browser=await chromium.launch({headless:true,...(process.env.CONCEPT_F_CHROMIUM_PATH?{executablePath:process.env.CONCEPT_F_CHROMIUM_PATH}:{})});let context,page;
try{
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await context.route('**/*',r=>r.request().url().startsWith(base+'/')?r.continue():r.abort());await context.routeWebSocket('**/*',socket=>socket.close());page=await context.newPage();page.setDefaultTimeout(20000);
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))receipt.writes.push({method:r.method(),path:new URL(r.url()).pathname});});
 await page.goto(base+'/login?redirectTo=/console/zerodha/portfolio');await page.getByLabel('Email Address',{exact:true}).fill('usera@stage01.example.com');await page.getByLabel('Password',{exact:true}).fill('SyntheticPreview123!');await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.waitForURL('**/console/zerodha/portfolio');
 await page.getByRole('heading',{name:'Review a refreshed simulation snapshot',exact:true}).waitFor();assert.equal(receipt.writes.some(r=>r.path.includes('snapshot-reviews')),false);
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/snapshot-reviews'));await page.getByRole('button',{name:'Preview synthetic snapshot',exact:true}).click();const r=await response;assert.equal(r.status(),200);const reviewed=await r.json();assert.equal(reviewed.state,'preview');await page.waitForURL(url=>url.searchParams.get('sourceReview')===reviewed.id);await page.reload();await page.getByText('Preview only; no source change was performed by this review.',{exact:true}).waitFor();receipt.checks.push('deliberate_preview_and_exact_owned_reload_no_auto_accept');
 await page.screenshot({path:output+'/F12-exact-proposal.png',fullPage:true});receipt.screenshots.push('F12-exact-proposal.png');
 const acceptance=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/snapshot-reviews/'+reviewed.id+'/accept'));await page.getByRole('button',{name:'Accept exact simulation snapshot',exact:true}).evaluate(el=>{el.click();el.click();});const accepted=await acceptance;assert.equal(accepted.status(),200);await page.getByText('Exact snapshot accepted and current.',{exact:true}).waitFor();assert.equal(receipt.writes.filter(r=>r.path.endsWith('/snapshot-reviews/'+reviewed.id+'/accept')).length,1);receipt.checks.push('exact_double_click_one_acceptance');
 await page.reload();await page.getByText('Exact snapshot accepted and current.',{exact:true}).waitFor();assert.equal(receipt.writes.filter(r=>r.path.endsWith('/accept')).length,1);receipt.checks.push('accepted_receipt_survives_reload_without_resubmit');
 assert.equal(receipt.writes.some(r=>/order-intents|analysis-workflows/.test(r.path)),false);receipt.passed=true;
}catch(error){receipt.error=String(error);if(page){receipt.failure_text=(await page.locator('body').innerText()).slice(0,14000);await page.screenshot({path:output+'/failure.png',fullPage:true});}throw error;}
finally{writeFileSync(output+'/receipt.json',JSON.stringify(receipt,null,2)+'\n');if(context)await context.close();await browser.close();}
