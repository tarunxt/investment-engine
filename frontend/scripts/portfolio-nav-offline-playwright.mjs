#!/usr/bin/env node
// Production sidebar and shell, synthetic identity, no backend or provider traffic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'sidebar-space-'));
const output=process.env.SIDEBAR_SCREENSHOT_DIR || '/tmp/credx-portfolio-nav-screenshots';
let browser,server;
try {
  await mkdir(output,{recursive:true});
  const navSource=process.env.PORTFOLIO_NAV_SOURCE || path.join(frontend,'components/shared/PortfolioAnalysisNav.tsx');
  await writeFile(path.join(temporary,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {PortfolioAnalysisNav} from '${navSource}';const portfolio=location.pathname.includes('indmoney')?'indmoneyUs':'zerodha';const active=({'swing-trade':'swingTrade',threats:'threats',events:'events',rebalance:'rebalance','final-actionables':'finalActionables'})[location.pathname.split('/')[3]] || 'portfolio';createRoot(document.getElementById('root')).render(<main style={{padding:24}}><h1>${process.env.PORTFOLIO_NAV_SOURCE ? 'Zerodha portfolio' : 'India Portfolio · Zerodha'}</h1><nav aria-label="Portfolio stages and markets"><PortfolioAnalysisNav portfolio={portfolio} active={active}/></nav></main>);`);
  await writeFile(path.join(temporary,'navigation.tsx'),`import {useSyncExternalStore} from 'react';export function useRouter(){return {replace:()=>{}}}export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}export function useSearchParams(){return new URLSearchParams(location.search)}`);
  await writeFile(path.join(temporary,'link.tsx'),`import React from 'react';export default function Link({href,prefetch,children,onClick,...props}){return <a {...props} href={href} onClick={e=>{e.preventDefault();history.pushState({},'',href);window.dispatchEvent(new Event('popstate'));onClick?.(e)}}>{children}</a>}`);
  await writeFile(path.join(temporary,'auth.ts'),`export function useAuth(){return {user:{id:42,username:'fixture',full_name:'Demo User',email:'demo@example.test'},logout:async()=>{window.logoutCalls++},loading:false,error:null}}`);
  await writeFile(path.join(temporary,'api.ts'),`export const apiService={updateProfile:async()=>{window.profileWrites++;throw Error('Unexpected profile write')}}`);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'next/navigation$':path.join(temporary,'navigation.tsx'),'next/link$':path.join(temporary,'link.tsx'),'@/hooks/useAuth$':path.join(temporary,'auth.ts'),'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
  const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer(async(req,res)=>{if(/^\/[\w.-]+\.js$/.test(req.url||'')){res.setHeader('Content-Type','text/javascript');try{res.end(req.url==='/bundle.js'?bundle:await readFile(path.join(temporary,req.url.slice(1))))}catch{res.statusCode=404;res.end('Missing fixture chunk')}}else {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial,sans-serif}</style><div id="root"></div><script>window.logoutCalls=0;window.profileWrites=0</script><script src="/bundle.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(); const errors=[],external=[],scriptRequests=[];
  page.on('request',request=>{if(request.resourceType()==='script')scriptRequests.push(request.url())});
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(external.push(route.request().url()),route.abort()));
  await page.addInitScript(()=>{localStorage.setItem('investment-engine:theme-preference','system');localStorage.setItem('unrelated-user-preference','preserve-me')});

  const routes={portfolio:'',swingTrade:'/swing-trade',threats:'/threats',events:'/events',rebalance:'/rebalance',finalActionables:'/final-actionables'};
  const labels={portfolio:'Portfolio',swingTrade:'Swing Trade',threats:'Threats',events:'Events',rebalance:'Rebalance',finalActionables:'Final Actionables'};
  const before=Boolean(process.env.PORTFOLIO_NAV_SOURCE);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto(base+'/console/zerodha');
    await page.getByRole('navigation').waitFor();
    assert.equal(await page.locator('a').count(),18);
    if(!before){
      for(const [key,suffix] of Object.entries(routes)){
        for(const [market,prefix] of [['India','/console/zerodha'],['US','/console/indmoney-us']]){
          const link=page.getByRole('link',{name:`Open ${market} ${labels[key]}`,exact:true});
          assert.equal(await link.getAttribute('href'),prefix+suffix);
          await link.focus(); assert.ok(await link.evaluate(el=>el===document.activeElement));
        }
      }
      assert.equal(await page.locator('[aria-current="page"]').count(),2);
      await page.getByText('Current market:',{exact:false}).waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.getByRole('link',{name:'Open US Portfolio',exact:true}).focus();
      await page.keyboard.press('Enter');
      assert.equal(new URL(page.url()).pathname,'/console/indmoney-us');
      await page.goBack();assert.equal(new URL(page.url()).pathname,'/console/zerodha');
    }
    await page.screenshot({animations:'disabled',path:path.join(output,`${before?'before':'after'}-portfolio-nav-${width}.png`)});
  }
  if(!before)for(const [market,prefix] of [['India','/console/zerodha'],['US','/console/indmoney-us']]){
    for(const [key,suffix] of Object.entries(routes)){
      await page.goto(base+prefix+suffix);
      const current=page.getByRole('link',{name:`${market} ${labels[key]}`,exact:true});
      await current.waitFor();assert.equal(await current.getAttribute('aria-current'),'page');
      assert.equal(await page.getByRole('link',{name:`Open ${market} ${labels[key]}`,exact:true}).getAttribute('aria-current'),'page');
      assert.equal(await page.locator('[aria-current="page"]').count(),2);
    }
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,`${before?'before':'after'}-results.json`),JSON.stringify({passed:true,widths:[1440,390],zoom:100,externalRequests:external,errors,routes},null,2));
  console.log(`PASS: ${before?'baseline':'after'} portfolio navigation, desktop/narrow, routes, keyboard and back; no external requests`);
} finally {await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(temporary,{recursive:true,force:true});}
