// Offline import form integration; every save resolves locally without network writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'us-import-')), output=process.env.PARSER_SCREENSHOT_DIR||'/tmp/trust-us-parser-evidence';
await mkdir(output,{recursive:true});
const baseline=process.env.PARSER_BASELINE==='1';
const component=baseline?path.join(temp,'Baseline.tsx'):path.join(frontend,'app/console/indmoney-us/_components/IndMoneyUsSnapshotsPanel.tsx');
if(baseline)await writeFile(component,execFileSync('git',['show','8212f9e93772a8f5a91f3f782640aeeff0fe7cc8:frontend/app/console/indmoney-us/_components/IndMoneyUsSnapshotsPanel.tsx'],{cwd:frontend}));
const holding={symbol:'ACME',company_name:'Reports',quantity:1,market_price:110,average_price:100,invested_value:100,current_value:110,total_pnl:10,total_pnl_percent:10,portfolio_weight_percent:100,market_change_percent:1};
const snapshot={id:1,snapshot_date:'2026-10-31',captured_at:'2026-10-31T10:00:00Z',source:'manual_paste',parse_status:'parsed',parse_warnings:[],holdings_count:1,reported_holdings_count:1,current_value:110.01,invested_value:100,day_return_value:1,total_return_value:10,wallet_balance:0,raw_text:'Reports\nAcme Example Company\nACME\nS&P 500\n6,000.00',holdings:[holding],market_indices:[],derived:{parsed_holdings_current_value:110,parsed_holdings_invested_value:100,parsed_holdings_total_pnl:10,profitable_holdings_count:1,loss_making_holdings_count:0,top_allocations:[holding],top_gainers:[],top_laggards:[],reconciliation:[{label:'Current Value',summary_value:110.01,parsed_value:110,delta:0.01}]}};
await writeFile(path.join(temp,'entry.tsx'),`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{IndMoneyUsSnapshotsPanel}from '${component}';const original=${JSON.stringify(snapshot)};function Fixture(){const[props,setProps]=useState({overview:{latest:original,history:[original]},selectedSnapshot:original,selectedSnapshotId:1,loading:false,selecting:false,error:null});window.fixture={setProps,original};return <IndMoneyUsSnapshotsPanel {...props} onSelectSnapshot={()=>{}}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle=await readFile(path.join(temp,'bundle.js'));const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;padding:24px}</style><div id="root"></div><script>window.submissions=[];</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
let passed=0;
try{
for(const {width,height} of [{width:1440,height:1000},{width:390,height:844}]){
 await page.setViewportSize({width,height});await page.goto(base+'/console/indmoney-us');await page.getByText('Raw Pasted Snapshot',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>devicePixelRatio),1);
 await page.screenshot({path:path.join(output,`${baseline?'before':'after'}-${width}.png`),fullPage:true});
 if(baseline)continue;
 await page.getByText('ACME · Display name needs review',{exact:true}).first().waitFor();
 await page.getByText('Holdings parsed',{exact:true}).waitFor();
 await page.getByText('Market-context extraction: Incomplete or unavailable.',{exact:true}).waitFor();
 assert.equal(await page.locator('pre').textContent(),snapshot.raw_text);assert.equal(await page.getByRole('cell',{name:'$0.01',exact:true}).count(),1);passed++;
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').count(),1);await page.keyboard.press('Enter');passed++;
 await page.evaluate(()=>fixture.setProps(p=>({...p,selectedSnapshot:{...fixture.original,market_indices:[{name:'S&P 500',value:6000,change_value:1,change_percent:0.1}]}})));
 await page.getByText('Market-context extraction: 1 index rows extracted; coverage is not verified.',{exact:true}).waitFor();passed++;
 await page.evaluate(()=>fixture.setProps(p=>({...p,selectedSnapshot:{...fixture.original,raw_text:'ACME only',holdings:[{...fixture.original.holdings[0],company_name:'Acme Example Company'}]}})));
 await page.getByText('Acme Example Company',{exact:true}).first().waitFor();assert.equal(await page.locator('pre').textContent(),'ACME only');passed++;
 await page.evaluate(()=>fixture.setProps(p=>({...p,selecting:true,selectedSnapshotId:2})));
 await page.getByRole('status').filter({hasText:'Loading snapshot details'}).waitFor();assert.equal(await page.locator('pre').textContent(),'ACME only');passed++;
 await page.evaluate(()=>fixture.setProps(p=>({...p,selecting:false,error:'Fixture detail read failed'})));await page.getByText('Fixture detail read failed',{exact:true}).waitFor();passed++;
 await page.evaluate(()=>fixture.setProps(p=>({...p,selectedSnapshot:null,overview:{history:[]},error:null})));await page.getByText('No INDmoney snapshots yet',{exact:true}).waitFor();passed++;
 await page.evaluate(()=>fixture.setProps(p=>({...p,overview:null,loading:true})));await page.getByRole('status').filter({hasText:'Loading INDmoney portfolio history'}).waitFor();passed++;
}
assert.deepEqual(errors,[]);console.log(`PASS ${passed} fixture checks; desktop 100%, narrow, keyboard, partial, index present/missing, retained raw/delta, loading, empty, error, stale selection. ${output}`);
}finally{await browser.close();server.close()}
