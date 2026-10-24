#!/usr/bin/env node

import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {isolatedEnvironment, browserReceipt, buildContentDigest} from "./stage18-browser-evidence.mjs";
import { fileURLToPath } from "node:url";

import { encode } from "next-auth/jwt";
import { chromium } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDirectory, "..");
const authSecret = "local-playwright-auth-hardening-secret";
const accessSentinel = "playwright-access-token-must-stay-server-only";
const refreshSentinel = "playwright-refresh-token-must-stay-server-only";

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a Playwright port");
  }
  return address.port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited before startup with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Playwright Next.js runtime");
}

async function sessionCookie(baseUrl, { expired = false,owner=71 } = {}) {
  const cookieName = "authjs.session-token";
  const now = Math.floor(Date.now() / 1_000);
  const userData = {
    id: owner,
    email: `playwright-auth-${owner}@example.invalid`,
    username: "playwright-auth",
    full_name: "Playwright Auth",
    role: "admin",
    is_active: true,
    is_verified: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_login: null,
    profile: null,
  };
  const expiresAt = expired ? now - 60 : now + 3_600;
  const value = await encode({
    secret: authSecret,
    salt: cookieName,
    token: {
      id: String(userData.id),
      sub: String(userData.id),
      email: userData.email,
      name: userData.full_name,
      username: userData.username,
      role: userData.role,
      accessToken: accessSentinel,
      refreshToken: refreshSentinel,
      expiresIn: 3_600,
      accessTokenExpiresAt: expiresAt * 1_000,
      sessionGeneration: expired ? "expired-generation" : "valid-generation",
      userData,
      iat: now - 60,
      exp: expiresAt,
    },
  });
  return {
    name: cookieName,
    value,
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
    expires: expiresAt,
  };
}

async function authenticatedContext(browser, baseUrl, options) {
  const context = await browser.newContext({
    serviceWorkers: "block",
    storageState: {
      cookies: [await sessionCookie(baseUrl, options)],
      origins: [],
    },
  });
  await context.route("**/*",route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort("blockedbyclient"));
  await context.routeWebSocket("**/*",socket=>socket.close());
  return context;
}

async function guardedContext(browser, baseUrl, options={}) {
 const context=await browser.newContext({...options,serviceWorkers:"block"});
 await context.route('**/*',route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort('blockedbyclient'));
 await context.routeWebSocket("**/*",socket=>socket.close());
 return context;
}

async function installSyntheticModulePolicy(page,{none=false,fail=false,owner=71}={}){
  const fixture=JSON.parse(readFileSync(path.join(frontendRoot,'tests/fixtures/stage08-ready-manifest.json'),'utf8'));
  fixture.owner_id=owner;for(const module of fixture.modules)for(const decision of Object.values(module.capabilities))decision.owner_id=owner;
  if(none)for(const module of fixture.modules){module.selection.enabled=false;for(const decision of Object.values(module.capabilities))decision.allowed=false;}
  await page.route('**/backend-api/me/modules',route=>route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail?{detail:'Synthetic policy outage'}:fixture)}));
}

async function assertDelayedBootstrapDoesNotGateContent(browser, baseUrl) {
  const context = await authenticatedContext(browser, baseUrl);
  const page = await context.newPage();
  await installSyntheticModulePolicy(page);
  let sessionRequestCompleted = false;
  await page.route(`${baseUrl}/api/auth/session`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
    sessionRequestCompleted = true;
  });

  const startedAt = performance.now();
  await page.goto(`${baseUrl}/console/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[data-console-shell="authenticated"]').waitFor();
  await page.locator('[data-dashboard-analytics="mounted"]').waitFor();
  const visibleAt = performance.now() - startedAt;
  if (visibleAt > 1_500) {
    throw new Error(`Server-authenticated dashboard content took ${visibleAt}ms`);
  }
  if (sessionRequestCompleted) {
    throw new Error("Client session bootstrap completed before the delayed render assertion");
  }
  const html = await page.content();
  if (/Restoring your secure session/i.test(html)) {
    throw new Error("Authenticated children were replaced by the legacy restoration gate");
  }
  if (html.includes(accessSentinel) || html.includes(refreshSentinel)) {
    throw new Error("A server-only token appeared in rendered HTML/RSC content");
  }
  await page.unrouteAll({ behavior: "wait" });
  await context.close();
}

async function assertAuthFailureStates(browser, baseUrl) {
  const anonymous = await guardedContext(browser,baseUrl);
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(`${baseUrl}/console/dashboard`);
  if (!new URL(anonymousPage.url()).pathname.startsWith("/login")) {
    throw new Error("Unauthenticated console request did not redirect to login");
  }
  // Exercise the optimized login feedback through the real public auth context.
  // Only this disposable callback is synthetic; no credential/provider is used.
  await anonymousPage.route('**/api/auth/callback/credentials', async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({url:baseUrl+'/api/auth/error?error=CredentialsSignin'})});
  });
  await anonymousPage.getByLabel('Email Address',{exact:true}).fill('login-check@example.invalid');
  await anonymousPage.getByLabel('Password',{exact:true}).fill('SyntheticRejected123!');
  const submitted=anonymousPage.waitForRequest(request=>new URL(request.url()).pathname==='/api/auth/callback/credentials');
  await anonymousPage.getByRole('button',{name:'Sign In',exact:true}).click();
  await submitted;
  if(!await anonymousPage.getByRole('button',{name:'Signing in...',exact:true}).isDisabled())throw new Error('Login pending state permits duplicate submission');
  await anonymousPage.getByRole('alert').getByText('Login Failed',{exact:true}).waitFor();
  await anonymousPage.getByRole('alert').getByText('Invalid email, username, or password.',{exact:true}).waitFor();
  await anonymousPage.getByRole('button',{name:'Dismiss login error',exact:true}).click();
  if(await anonymousPage.getByRole('alert').count())throw new Error('Login error dismissal did not clear feedback');
  await anonymous.close();

  const expired = await authenticatedContext(browser, baseUrl, { expired: true });
  const expiredPage = await expired.newPage();
  await expiredPage.goto(`${baseUrl}/console/dashboard`);
  if (!new URL(expiredPage.url()).pathname.startsWith("/login")) {
    throw new Error("Expired Auth.js session did not redirect to login");
  }
  await expired.close();

  const failed = await authenticatedContext(browser, baseUrl);
  const failedPage = await failed.newPage();
  await failedPage.route(`${baseUrl}/api/auth/session`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"session unavailable"}',
    }),
  );
  await failedPage.goto(`${baseUrl}/console/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await failedPage.waitForTimeout(1_000);
  const failedHtml = await failedPage.content();
  if (/Restoring your secure session/i.test(failedHtml)) {
    throw new Error("Failed session endpoint caused an indefinite restoration screen");
  }
  const failedPath = new URL(failedPage.url()).pathname;
  const explicitState =
    failedPath.startsWith("/login") ||
    (await failedPage.locator('[data-console-shell="authenticated"]').count()) > 0;
  if (!explicitState) {
    throw new Error("Failed session endpoint produced neither recoverable content nor redirect");
  }
  await failed.close();
}

async function assertInteractiveRoutesLoadByDefault(browser, baseUrl) {
  const context = await authenticatedContext(browser, baseUrl);
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto(`${baseUrl}/console/bullpen-ai`, {
    // Polling screens need their visible mounted marker, not network silence.
    waitUntil: "domcontentloaded",
  });
  await installSyntheticModulePolicy(page);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Module unavailable or disabled'}).waitFor();
  if(await page.locator('[data-bullpen-workspace="mounted"]').count())throw new Error('Unavailable Bullpen workspace mounted');
  if(requests.some(url=>/\/(backend-api|api)\/(bullpen|polymarket)/.test(url)))throw new Error('Disabled Bullpen issued a data request');
  if (await page.getByText("Interactive workspace").count()) {
    throw new Error("Bullpen workspace still shows the interaction prompt");
  }
  if (!requests.some((url) => url.includes("/_next/static/chunks/"))) {
    throw new Error("Bullpen workspace did not load its route chunks");
  }

  const dashboardPage = await context.newPage();
  const dashboardRequests = [];
  dashboardPage.on("request", (request) =>
    dashboardRequests.push(request.url()),
  );
  await installSyntheticModulePolicy(dashboardPage);
  await dashboardPage.goto(`${baseUrl}/console/dashboard`, {
    // Polling screens need their visible mounted marker, not network silence.
    waitUntil: "domcontentloaded",
  });
  await dashboardPage.locator('[data-dashboard-analytics="mounted"]').waitFor();
  if (await dashboardPage.getByText("Charts and portfolio tools").count()) {
    throw new Error("Dashboard analytics still shows the interaction prompt");
  }
  if (!dashboardRequests.some((url) => url.includes("/_next/static/chunks/"))) {
    throw new Error("Dashboard did not load its analytics route chunks");
  }

  const empty=await context.newPage();await installSyntheticModulePolicy(empty,{none:true});
  await empty.goto(`${baseUrl}/console/dashboard`,{waitUntil:'domcontentloaded'});
  await empty.getByRole('heading',{name:'Choose your modules'}).waitFor();
  if(await empty.locator('[data-dashboard-analytics="mounted"]').count())throw new Error('No-module dashboard mounted hidden analytics');
  const failed=await context.newPage();await installSyntheticModulePolicy(failed,{fail:true});
  await failed.goto(`${baseUrl}/console/zerodha`,{waitUntil:'domcontentloaded'});
  await failed.getByRole('heading',{name:'Module preferences unavailable'}).waitFor();
  await context.close();
}

async function assertProfileNavigationWidths(page,baseUrl){
 const expected=['Profile','Preferences','Platform Cost Drivers','Security','Activity'];
 for(const width of [320,360,390,430]){
  await page.setViewportSize({width,height:844});
  await page.goto(`${baseUrl}/console/profile/preferences`,{waitUntil:'domcontentloaded'});
  const nav=page.locator('main aside nav');await nav.waitFor({state:'visible'});
  const links=nav.getByRole('link');
  if(JSON.stringify(await links.allTextContents())!==JSON.stringify(expected))throw new Error('Profile navigation labels/order changed');
  const geometry=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));
  if(geometry.documentWidth>geometry.width)throw new Error(`Profile navigation overflows at ${width}px: document ${geometry.documentWidth}px`);
  if(await nav.getAttribute('aria-label')!=='Profile settings'||await nav.getByRole('link',{name:'Preferences',exact:true}).getAttribute('aria-current')!=='page')throw new Error('Profile navigation accessibility labels/current page missing');
  await links.nth(0).focus();
  for(let i=0;i<expected.length;i++){
   const link=links.nth(i);
   if(!await link.evaluate(node=>document.activeElement===node))throw new Error(`Profile Tab order lost ${expected[i]} at ${width}px`);
   const bounds=await link.boundingBox();
   if(!bounds||bounds.x<0||bounds.x+bounds.width>width+1||bounds.y<0||bounds.y+bounds.height>844)throw new Error(`Profile tab unreachable in viewport: ${expected[i]} at ${width}px`);
   if(i<expected.length-1)await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Enter');await page.waitForURL(`${baseUrl}/console/profile/activity`);
  await page.getByRole('heading',{name:'Activity',exact:true}).waitFor();
  await page.goto(`${baseUrl}/console/profile/preferences`,{waitUntil:'domcontentloaded'});
  await page.locator('main aside nav').getByRole('link',{name:'Security',exact:true}).press('Enter');
  await page.waitForURL(`${baseUrl}/console/profile/security`);
  console.log(`Stage08 profile tabs fit ${width}x844; all five Tab-reachable; Activity/Security Enter navigation passed`);
 }
 await page.goto(`${baseUrl}/console/profile/preferences`,{waitUntil:'domcontentloaded'});
}

async function assertStage08PreferenceFlows(browser,baseUrl){
 const context=await authenticatedContext(browser,baseUrl);
 let manifest=JSON.parse(readFileSync(path.join(frontendRoot,'tests/fixtures/stage08-ready-manifest.json'),'utf8'));
 let holdNextPatch=false,releaseHeld,markHeld;let heldStarted;
 for(const module of manifest.modules){module.selection.enabled=false;for(const d of Object.values(module.capabilities))d.allowed=false;}
 const bind=async(page)=>{
  await page.route('**/backend-api/me/modules',async route=>{
   if(route.request().method()==='PATCH'){
    const body=route.request().postDataJSON();
    if(body.expected_version!==manifest.version)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{code:'MODULE_VERSION_CONFLICT'}})});
    for(const update of body.updates){const module=manifest.modules.find(m=>m.module_id===update.module_id);module.selection.enabled=update.enabled;for(const [cap,d] of Object.entries(module.capabilities))d.allowed=update.enabled&&module.availability.available&&['view','analyze'].includes(cap);}
    manifest.version++;
    if(holdNextPatch){holdNextPatch=false;const committed=JSON.stringify(manifest);markHeld();await new Promise(resolve=>{releaseHeld=resolve;});return route.fulfill({status:200,contentType:'application/json',body:committed});}
   }
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(manifest)});
  });
  await page.route('**/backend-api/me/modules/disable-impact',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({version:manifest.version,active_work:{queued_analysis:0,running_analysis:0,reason:'Private synthetic browser fixture; no actual jobs'},dependent_modules:[]})}));
 };
 const first=await context.newPage();await bind(first);
 await first.goto(`${baseUrl}/console/profile/preferences`,{waitUntil:'domcontentloaded'});
 await first.getByRole('heading',{name:'Start with the modules you need'}).waitFor();
 if(await first.getByRole('checkbox',{name:'Select Bullpen Live',exact:true}).isEnabled())throw new Error('Unavailable Bullpen checkbox enabled');
 const second=await context.newPage();await bind(second);
 await second.goto(`${baseUrl}/console/profile/preferences`,{waitUntil:'domcontentloaded'});
 await second.getByRole('heading',{name:'Start with the modules you need'}).waitFor();
 await first.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).click();
 await second.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).waitFor({state:'visible'});
 await second.waitForFunction(()=>document.querySelector('[aria-label="Select Zerodha Rebalance"]')?.checked===true);
 await first.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).click();
 await first.getByRole('alertdialog').waitFor();await first.keyboard.press('Escape');
 if(!(await first.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).isChecked()))throw new Error('Cancelled disable changed selection');
 // Simulate an unseen external version update. UI must reload, not overwrite.
 manifest.version++;
 await first.getByRole('checkbox',{name:'Select INDmoney US',exact:true}).click();
 await first.getByText('Preferences changed or this module is unavailable.',{exact:false}).waitFor();
 if(await first.getByRole('checkbox',{name:'Select INDmoney US',exact:true}).isChecked())throw new Error('Conflicted save granted a selection');
 // Commit an enable but delay its response; the other actual tab disables it
 // and broadcasts the newer version before the first response is released.
 heldStarted=new Promise(resolve=>{markHeld=resolve;});holdNextPatch=true;
 await first.getByRole('checkbox',{name:'Select INDmoney US',exact:true}).click();await heldStarted;
 await second.reload({waitUntil:'domcontentloaded'});
 await second.waitForFunction(()=>document.querySelector('[aria-label="Select INDmoney US"]')?.checked===true);
 await second.getByRole('checkbox',{name:'Select INDmoney US',exact:true}).click();
 await second.getByRole('button',{name:'Confirm disable',exact:true}).click();
 await second.getByText('INDmoney US disabled.',{exact:false}).waitFor();
 releaseHeld();
 await first.getByText('Preferences changed in another tab or session.',{exact:false}).waitFor();
 await first.waitForFunction(()=>document.querySelector('[aria-label="Select INDmoney US"]')?.checked===false);
 console.log('Stage08 delayed PATCH versus real cross-tab disable invalidation passed');
 await assertProfileNavigationWidths(first,baseUrl);
 await first.setViewportSize({width:390,height:844});
 await first.getByRole('button',{name:'Open navigation',exact:true}).click();
 if(await first.getByRole('button',{name:'Open navigation',exact:true}).getAttribute('aria-expanded')!=='true')throw new Error('Mobile navigation did not expand');
 await first.getByRole('button',{name:'Close navigation',exact:true}).click();
 // Owner swap uses signed synthetic identities, never the live owner or Google.
 await context.addCookies([await sessionCookie(baseUrl,{owner:72})]);
 manifest.owner_id=72;manifest.version=0;for(const module of manifest.modules){module.selection.enabled=false;module.selection.version=0;for(const d of Object.values(module.capabilities)){d.allowed=false;d.owner_id=72;d.selection_version=0;}}
 await first.reload({waitUntil:'domcontentloaded'});
 await first.getByRole('heading',{name:'Start with the modules you need'}).waitFor();
 if(await first.getByRole('checkbox',{name:'Select Zerodha Rebalance',exact:true}).isChecked())throw new Error('Account switch retained prior selections');
 await context.close();
}

async function assertBoundedBrowserLoad(browser,baseUrl) {
 const durations=[];let active=0,peak=0;
 const started=performance.now();
 // Three actual isolated contexts, each with four sequential navigations.
 await Promise.all([71,72,73].map(async owner=>{
  const context=await authenticatedContext(browser,baseUrl,{owner});
  try {const page=await context.newPage();await installSyntheticModulePolicy(page,{none:true,owner});
   for(let n=0;n<4;n++) {const start=performance.now();active++;peak=Math.max(peak,active);
    try {await page.goto(`${baseUrl}/console/dashboard`,{waitUntil:'domcontentloaded',timeout:10000});await page.getByRole('heading',{name:'Choose your modules'}).waitFor({timeout:10000});}
    finally {active--;}
    durations.push((performance.now()-start)/1000);
   }
  } finally {await context.close();}
 }));
 durations.sort((a,b)=>a-b);
 return {completed:durations.length,errors:0,configured_concurrency:3,observed_peak_concurrency:peak,duration_seconds:(performance.now()-started)/1000,p95_seconds:durations[Math.ceil(.95*durations.length)-1],threshold_seconds:10,scope:'Actual Chromium navigation against loopback Next.js with synthetic module policy, not backend/proxy capacity'};
}

async function main() {
  const receiptPath=process.env.STAGE18_BROWSER_RECEIPT || '/tmp/stage18-browser-receipt.json';
  writeFileSync(receiptPath,JSON.stringify({kind:'synthetic_loopback_browser_subset',passed:false,reason:'Run not completed',full_release_verified:false,browser_load_verified:false,real_provider_certification:false})+'\n');
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:frontendRoot,encoding:'utf8'}).trim();
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [path.join(frontendRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "-p", String(port)],
    {
      cwd: frontendRoot,
      env: isolatedEnvironment(baseUrl, process.env.PATH, path.resolve(frontendRoot,'../scripts/public_launch/preview_network.cjs'),port),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  let browser;
  try {
    await waitForServer(baseUrl, child);
    const fingerprintResponse=await fetch(`${baseUrl}/api/runtime-fingerprint`);
    const fingerprint=await fingerprintResponse.json();
    if(!fingerprintResponse.ok || fingerprint.build_sha!==sourceSha)throw new Error('Served build fingerprint does not match exact source HEAD; stamp and rebuild first');
    browser = await chromium.launch({ headless: true, env:{PATH:process.env.PATH,HOME:"/tmp"}, ...(process.env.STAGE18_CHROMIUM_PATH ? {executablePath:process.env.STAGE18_CHROMIUM_PATH} : {}) });
    const checks=[];
    const check=async(name,fn)=>{const start=performance.now();await fn(browser,baseUrl);checks.push({name,passed:true,duration_seconds:(performance.now()-start)/1000});};
    await check('delayed_bootstrap',assertDelayedBootstrapDoesNotGateContent);
    await check('auth_failure_states',assertAuthFailureStates);
    await check('module_routes',assertInteractiveRoutesLoadByDefault);
    await check('preference_races_account_switch_mobile',assertStage08PreferenceFlows);
    const load=await assertBoundedBrowserLoad(browser,baseUrl);
    const files=['scripts/auth-rendering-playwright.mjs','scripts/stage18-browser-evidence.mjs','tests/fixtures/stage08-ready-manifest.json','.next/BUILD_ID','.next/build-manifest.json','.next/server/app-paths-manifest.json'].map(f=>path.join(frontendRoot,f));
    const receipt=browserReceipt({sourceSha,files,checks,load});
    writeFileSync(receiptPath,JSON.stringify({...receipt,served_fingerprint:fingerprint,working_tree_diff_sha256:createHash('sha256').update(execFileSync('git',['diff','HEAD','--binary'],{cwd:frontendRoot})).digest('hex'),served_build_content:buildContentDigest(path.join(frontendRoot,'.next'))},null,2)+'\n');
    console.log("Stage08 policy, cross-tab, conflict, cancelled-disable, mobile and synthetic-account-switch checks passed");
    console.log("Auth rendering and lazy-route Playwright checks passed");
  } catch (error) {
    if (output) console.error(output);
    throw error;
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
}

await main();
