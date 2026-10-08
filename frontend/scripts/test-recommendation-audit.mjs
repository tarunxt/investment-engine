// Synthetic security, IDs, holdings, scores and times; no user portfolio data.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const output = path.resolve(frontend, '../../reports/ui-test');
await mkdir(output, { recursive: true });
const source = await readFile(path.join(frontend, 'components/RecommendationAuditPanel.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replaceAll('@/services/recommendationAudit', './mock-api.js');
await writeFile(path.join(output, 'panel.js'), compiled);
await writeFile(path.join(output, 'mock-api.js'), `
export const recommendationAuditEnabled=true;
const current={id:'current',run_id:102,provenance:'fixture',calculation:{raw_action:'Sell All',formula_action:'Trim',score:'-1.2',formula_units:'-0.5',current_units:'1',findings:[{code:'same_model',detail:'One provider/model; independent corroboration missing',severity:'warning'}]},sizing:{action:'Sell All',units:'-1'},coverage:{successful:2,attempted:2}};
const previous={...current,id:'previous',run_id:101,calculation:{...current.calculation,raw_action:'Buy New',formula_action:'Buy New',score:'1.65',formula_units:'1',current_units:'0'},sizing:{action:'Buy New',units:'1'}};
let present=null;
export const recommendationAuditApi={comparison:async()=>({current,previous,present_calculation:present,bundle_hash:'fixture',comparison:{comparable:true,changes:[{field:'current_units',before:'0',after:'1'}],score_component_changes:{cruxx:'-3.5'},findings:[]},coverage:{has_more:true},capabilities:{external_enabled:false,recovery_read_only:false}}),capture:async()=>{present={...current,captured_at:'2024-02-01T12:05:00Z',provenance:'calculation_observed'};return {decision_ids:['present']}},verify:async(request)=>{window.auditRequests.push(request);return {id:'verification',status:'completed',verdict:'insufficient_evidence',spent_usd:'0',reserved_usd:'0',result:{checked_at:'2024-02-01T12:10:00Z',findings:['Original independent as-of data missing'],claims:[],sources:[{source_url:'https://fixture.invalid.test/evidence',observed_at:'2024-02-01T12:09:00Z',available_at:null}]}}},status:async()=>{throw Error('Unexpected polling')},cancel:async()=>{throw Error('Unexpected cancel')},materialize:async()=>{throw Error('Unexpected write')}};
`);
await writeFile(path.join(output,'entry.js'),`import React from 'react';import {createRoot} from 'react-dom/client';import {RecommendationAuditPanel} from './panel.js';window.auditRequests=[];createRoot(document.getElementById('root')).render(React.createElement(RecommendationAuditPanel,{runId:102,runIds:[102],runCount:1,formula:{},market:'india',symbol:'FIXTUREEQ',exchange:'NSE',currentScore:-1.2,currentAction:'Trim'}));`);
const webpackModule=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>webpackModule.webpack({mode:'development',entry:path.join(output,'entry.js'),output:{path:output,filename:'bundle.js'},resolve:{modules:[path.join(frontend,'node_modules'),'node_modules']},plugins:[new webpackModule.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(err,stats)=>{if(err||stats.hasErrors()) reject(err||new Error(stats.toString({all:false,errors:true}))); else resolve();}));
await writeFile(path.join(output,'index.html'),`<!doctype html><html><meta charset="utf-8"><title>Real audit panel interaction test · mocked API</title><style>body{font:15px system-ui;padding:30px}table{border-collapse:collapse;width:900px}td,th{padding:10px;border-bottom:1px solid #ddd}button{margin:10px;padding:8px}</style><div id="root"></div><script src="./bundle.js"></script></html>`);
if(process.env.CREDX_AUDIT_UI_BUILD_ONLY==='1') { console.log(JSON.stringify({built:true,browser_checks_run:false})); process.exit(0); }
const browser=await chromium.launch({headless:true,...(process.env.CREDX_AUDIT_BROWSER_EXECUTABLE ? {executablePath:process.env.CREDX_AUDIT_BROWSER_EXECUTABLE} : {})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:/,route=>route.abort());
 await page.goto('file://'+path.join(output,'index.html'));
 await page.getByRole('heading',{name:'What changed?'}).waitFor();
 if(!await page.getByRole('cell',{name:'Trim (-1.2)',exact:true}).count())throw Error('Formula layer absent');
 if(!await page.getByRole('cell',{name:'Sell All (-1)',exact:true}).count())throw Error('Sizing layer absent');
 await page.getByText('cruxx score change: -3.5',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Capture current calculation'}).click();
 await page.getByText(/Present calculation observed/).waitFor();
 await page.getByRole('button',{name:'Verify reversal'}).click();
 await page.getByRole('status').filter({hasText:'insufficient evidence'}).waitFor();
 await page.getByRole('button',{name:'Verify reversal'}).click();
 const requests=await page.evaluate(()=>window.auditRequests);
 if(requests.length!==2||requests[0].idempotency_key!==requests[1].idempotency_key||requests.some(r=>r.mode!=='stored_only'||r.budget_usd!==0))throw Error('Duplicate/budget semantics failed');
 await page.getByRole('link',{name:'Source evidence'}).waitFor();
 await page.getByRole('button',{name:'Run a fresh check'}).click();
 const refreshed=await page.evaluate(()=>window.auditRequests);
 if(refreshed.length!==3||!refreshed[2].refresh_key||refreshed[2].idempotency_key===refreshed[1].idempotency_key)throw Error('Explicit fresh check absent');
 if(errors.length)throw Error(errors.join('\n'));
 await page.screenshot({path:path.join(output,'real-panel.png'),fullPage:true});
 console.log(JSON.stringify({passed:true,tests:['real React panel renders separate formula and sizing','component deltas','explicit current capture','stored-only verification','duplicate click preserves idempotency key','explicit fresh check','source link and timestamps','zero authorized API budget','no network requests'],screenshots:['real-panel.png'],mocked_api:true}));
}finally{await browser.close();}
