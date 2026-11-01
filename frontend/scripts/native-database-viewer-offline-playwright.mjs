// Only synthetic local APIs and a private socket; no real session or database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright';
import { authorizeDatabaseOwner } from '../lib/databaseViewerOwner.ts';
import { createDatabaseViewerSocketFetcher } from '../lib/databaseViewerSocket.ts';
import { proxyDatabaseDestination } from '../lib/databaseViewerProxy.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp('/tmp/a6-native-browser-');
const socket=path.join(directory,'viewer.sock');
const previous=process.env.DATABASE_VIEWER_SOCKET_PATH;
// Namespace-mapped /tmp/root metadata only; the real private socket ACL is tested.
const fixtureTransport=createDatabaseViewerSocketFetcher(async name=>{const entry=await lstat(name);return name==='/'||name==='/tmp'?{uid:0,mode:entry.mode,isDirectory:()=>entry.isDirectory(),isSocket:()=>entry.isSocket()}:entry;});
let child,server,browser;
let nativeCalls=0;
try {
  await chmod(directory,0o700);
  child=spawn(process.env.VIEWER_TEST_PYTHON||'python3',[path.join(root,'server/database-viewer/fixtures/serve_fixture.py'),socket],{
    env:{PATH:process.env.PATH,...(process.env.VIEWER_TEST_PYTHONPATH?{PYTHONPATH:process.env.VIEWER_TEST_PYTHONPATH}:{})},stdio:['ignore','ignore','pipe'],
  });
  let failure='';child.stderr.on('data',chunk=>{failure+=chunk.toString().slice(0,2000);});
  let ready=false;
  for(let attempt=0;attempt<100;attempt++) {
    if(child.exitCode!==null) throw new Error('Synthetic service exited: '+failure);
    if(await stat(socket).then(()=>true).catch(()=>false)) {ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Synthetic socket did not appear');await chmod(socket,0o600);process.env.DATABASE_VIEWER_SOCKET_PATH=socket;
  const source=(await readFile(path.join(root,'lib/databaseViewerRoute.ts'),'utf8')).replace(/^import .*;$/gm,'');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  new Function('exports','process','getToken','readCookieNames','resolveSessionCookieSecurity','authorizeDatabaseOwner','proxyDatabaseDestination',code)(
    exports,{env:{DATABASE_VIEWER_OWNER_USER_ID:'71',NEXTAUTH_SECRET:'synthetic-fixture-secret'}},
    async({req})=>{const cookie=req.headers.get('cookie')||'';return cookie.includes('fixture_owner=owner')?{accessToken:'synthetic-owner'}:cookie.includes('fixture_owner=other')?{accessToken:'synthetic-other'}:null;},
    ()=>[],()=>false,
    (request,options)=>authorizeDatabaseOwner(request,{...options,fetcher:async(_url,init)=>Response.json({id:init.headers.Authorization==='Bearer synthetic-owner'?71:72,is_active:true,role:'admin'})}),
    async request=>{nativeCalls++;return proxyDatabaseDestination(request,fixtureTransport);},
  );
  server=createServer(async(request,response)=>{
    try {
      const result=await exports.protectedDatabaseDestination(new Request(`http://127.0.0.1:${server.address().port}${request.url}`,{method:request.method,headers:request.headers}));
      response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
    } catch {response.writeHead(500);response.end('Synthetic gateway failed');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin+'/database')).status,401);assert.equal(nativeCalls,0);
  assert.equal((await fetch(origin+'/database/tables/jobs',{headers:{cookie:'fixture_owner=other'}})).status,403);assert.equal(nativeCalls,0);
  assert.equal((await fetch(origin+'/database',{method:'POST',headers:{cookie:'fixture_owner=owner'}})).status,405);assert.equal(nativeCalls,0);
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  let cases=0;
  for(const viewport of [{width:1180,height:757},{width:390,height:844}]) {
    const context=await browser.newContext({viewport,serviceWorkers:'block'});
    const external=[];
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
    await context.addCookies([{name:'fixture_owner',value:'owner',url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/database');await page.getByRole('heading',{name:'Database',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.getByRole('link',{name:'jobs',exact:true}).click();await page.getByRole('heading',{name:'jobs',exact:true}).waitFor();
    if(process.env.NATIVE_VIEWER_SCREENSHOTS) await page.screenshot({path:path.join(process.env.NATIVE_VIEWER_SCREENSHOTS,`native-${viewport.width}.png`),fullPage:false});
    await page.getByText('Permitted table structure',{exact:true}).click();
    assert.equal(await page.locator('details').evaluate(element=>element.open),true);
    assert.equal(await page.locator('body').innerText().then(text=>text.includes('request_context_json')),false);
    await page.getByRole('link',{name:'Next page',exact:true}).click();
    assert.ok(new URL(page.url()).searchParams.has('before'));
    await page.getByRole('link',{name:'Clear filters and pagination',exact:true}).click();
    await page.getByLabel('Exact-match column').selectOption('status');await page.getByLabel('Value',{exact:true}).fill('completed');
    await page.getByRole('button',{name:'Filter',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('value'),'completed');
    await page.getByRole('link',{name:'Open row 60',exact:true}).click();
    await page.getByRole('heading',{name:'jobs — row 60',exact:true}).waitFor();
    assert.ok((await page.locator('body').innerText()).includes('0.123456789123456789'));
    await page.goBack();
    await page.getByRole('link',{name:'Clear filters and pagination',exact:true}).focus();
    assert.equal(await page.getByRole('link',{name:'Clear filters and pagination',exact:true}).evaluate(element=>element.matches(':focus-visible')),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const rows=page.getByRole('region',{name:'Saved rows',exact:true});
    await rows.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(100);
    assert.equal(await rows.evaluate(element=>element.scrollLeft>0),true);
    assert.deepEqual(external,[]);cases++;
    await context.close();
  }
  console.log(JSON.stringify({cases,unauthenticated:401,nonOwner:403,writes:405,realDatabase:false,nativeSocket:true,precisionPreserved:true}));
} finally {
  if(browser) await browser.close();
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(child) {child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  if(previous===undefined) delete process.env.DATABASE_VIEWER_SOCKET_PATH;else process.env.DATABASE_VIEWER_SOCKET_PATH=previous;
  await rm(directory,{recursive:true,force:true});
}
