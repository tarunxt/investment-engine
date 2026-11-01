// Offline component integration: real settings shell, layout, details and review.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'cost-recovery-')), output=process.env.COST_SCREENSHOT_DIR||'/tmp/cost-recovery-evidence';
await mkdir(output,{recursive:true});
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import Settings from '${frontend}/app/console/profile/layout';import Layout from '${frontend}/app/console/profile/cost-drivers/layout';import Page from '${frontend}/app/console/profile/cost-drivers/page';createRoot(document.getElementById('root')).render(<React.StrictMode><Settings><Layout><Page/></Layout></Settings></React.StrictMode>);`);
await writeFile(path.join(temp,'api.ts'),`export const apiService={get:(url)=>new Promise((resolve,reject)=>{window.requests.push({url,resolve,reject})}),post:()=>{window.writes++;throw Error('Blocked write')}};`);
await writeFile(path.join(temp,'link.tsx'),`import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
await writeFile(path.join(temp,'nav.ts'),`export const usePathname=()=>'/console/profile/cost-drivers';`);
await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'next/link$':path.join(temp,'link.tsx'),'next/navigation$':path.join(temp,'nav.ts'),'@/services/api$':path.join(temp,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle=await readFile(path.join(temp,'bundle.js'));const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;padding:24px}</style><div id="root"></div><script>window.requests=[];window.writes=0;</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
const fixture=(cost)=>({summary:{monthToDateAwsCost:cost,projectedMonthEndCost:cost},dailyCostTrend:[],dataTransferTrend:[],topServices:[],topUsageTypes:[],costDrivers:[],traffic:[],recommendations:[],inventory:{},debug:{}});
const settle=async(index,data,fail=false)=>page.evaluate(({index,data,fail})=>{window.requests[index][fail?'reject':'resolve'](fail?Error(data):data)},{index,data,fail});
try{
for(const {width,height} of [{width:1180,height:757},{width:1440,height:900},{width:390,height:844}]){
 await page.setViewportSize({width,height});await page.goto(base);await page.getByRole('status').waitFor();await page.waitForFunction(()=>requests.length===1);assert.equal(await page.getByRole('heading',{name:'Settings',exact:true}).count(),1);await settle(0,'backend timeout after 4 seconds',true);
 await page.getByRole('region',{name:'Usage and costs unavailable'}).waitFor();assert.equal(await page.getByRole('alert').count(),1);assert.equal(await page.getByText('backend timeout',{exact:false}).count(),0);assert.equal(await page.getByText('$0.00',{exact:false}).count(),0);assert.equal(await page.getByRole('link',{name:'API cost details'}).getAttribute('href'),'/console/apis');
 assert.equal(await page.getByRole('heading',{name:'Usage and costs unavailable',exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Retry usage',exact:true}).count(),1);
 const recovery=page.getByRole('region',{name:'Usage and costs unavailable'});
 const bounds=await recovery.boundingBox();
 assert.ok(bounds.height<250,'Unavailable panel should fit its content');
 assert.ok(bounds.width<=width-48,'Recovery panel should fit the viewport');
 // Repeated errors must keep one recovery message/action and retain keyboard access.
 await page.getByRole('button',{name:'Retry usage'}).focus();
 await page.keyboard.press('Tab');
 assert.equal(await page.getByRole('link',{name:'API cost details'}).evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Shift+Tab');
 await page.keyboard.press('Enter');
 await page.getByRole('status').waitFor();
 await page.waitForFunction(()=>requests.length===2);
 await settle(1,'backend timeout again',true);
 await recovery.waitFor();
 assert.equal(await page.getByRole('alert').count(),1);
 assert.equal(await page.getByRole('button',{name:'Retry usage',exact:true}).count(),1);
 assert.equal(await page.getByText('$0.00',{exact:false}).count(),0);
 await page.getByRole('button',{name:'Retry usage'}).focus();assert.equal(await page.getByRole('button',{name:'Retry usage'}).evaluate(el=>el===document.activeElement),true);await page.screenshot({path:path.join(output,`failed-${width}.png`)});await page.keyboard.press('Enter');await page.getByRole('status').waitFor();await page.waitForFunction(()=>requests.length===3);await settle(2,fixture(12.34));await page.getByRole('heading',{name:'Platform Cost Drivers',exact:true}).waitFor();await page.waitForFunction(()=>requests.length>=4);await settle(3,fixture(8));assert.ok(await page.getByText('$12.34',{exact:true}).count()>0);await page.screenshot({path:path.join(output,`success-${width}.png`)});
 assert.equal(await page.evaluate(()=>writes),0);
}
await page.goto(base);await page.waitForFunction(()=>requests.length===1);await settle(0,fixture(0));await page.getByRole('heading',{name:'Platform Cost Drivers',exact:true}).waitFor();assert.ok(await page.getByText('No AWS Cost Explorer service spend',{exact:false}).count());assert.ok(await page.getByText('$0.00',{exact:true}).count()>0);
// A late comparison from an unmounted month cannot replace the new month.
await page.waitForFunction(()=>requests.length>=2);await page.locator('#cost-driver-month').selectOption({index:1});await page.waitForFunction(()=>requests.length>=3);await settle(1,fixture(99999));await settle(2,fixture(44.44));await page.getByRole('heading',{name:'Platform Cost Drivers',exact:true}).waitFor();assert.equal(await page.getByText('$99999.00',{exact:false}).count(),0);assert.ok(await page.getByText('$44.44',{exact:true}).count()>0);await page.goto(base);await page.waitForFunction(()=>requests.length===1);await settle(0,{...fixture(0),summary:{}});await page.getByText('Cost totals are unknown for this month.').waitFor();assert.equal(await page.getByText('$0.00',{exact:true}).count(),0);assert.ok(await page.getByText('Unknown',{exact:true}).count()>0);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>writes),0);console.log('PASS: loading, single failure, shell, keyboard retry, success, confirmed empty, stale comparison, desktop/mobile; no writes or external calls. Screenshots: '+output);
}finally{await browser.close();server.close()}
