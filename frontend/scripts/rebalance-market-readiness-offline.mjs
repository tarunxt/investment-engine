#!/usr/bin/env node
// Offline browser: unchanged production input component and synthetic API/context.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';import postcss from 'postcss';import tailwind from '@tailwindcss/postcss';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'rebalance-market-readiness-'));const output='/tmp/rebalance-market-readiness-evidence';await mkdir(output,{recursive:true});
const source=await readFile(path.join(root,'app/console/_components/PortfolioRebalanceConsole.tsx'),'utf8');
const ast=ts.createSourceFile('component.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations=ast.statements.filter(n=>!ts.isImportDeclaration(n)&&!ts.isExpressionStatement(n)&&n.getStart(ast)<source.indexOf('export function PortfolioRebalanceConsole')).map(n=>n.getText(ast)).join('\n');
const entry=`import React,{useState,useEffect,useMemo,useCallback,useRef,createContext,useContext} from 'react';
import {createRoot} from 'react-dom/client';
import {AlertCircle,BriefcaseBusiness,ChevronDown,ChevronUp,RefreshCw,ShieldAlert,TrendingUp} from 'lucide-react';
import {Button} from '@/components/ui/button';import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {RebalanceReadiness} from '@/app/console/_components/RebalanceReadiness';import {PortfolioAnalysisNav} from '@/components/shared/PortfolioAnalysisNav';
import {buildRebalanceInputBundle,REBALANCE_INPUT_SECTION_MARKERS,getPreviousMarketClose} from '@/lib/rebalance';
import {isRunInSwingTradeMarket} from '@/lib/runPresentation';
const CreateJobCard=()=>null; // Submission boundary excluded: no jobs or paid calls.
const Context=createContext(null);const useDashboard=()=>useContext(Context);
const params=new URL(location.href).searchParams,market=params.get('market')||'india';const state=params.get('state')||'stale';
const snapshot={holdings_count:1,positions:{net:[],day:[]},snapshot_date:'2020-01-01',captured_at:'2020-01-01T00:00:00Z',parse_status:'parsed',reported_holdings_count:1,holdings:market==='india'?[{exchange:'NSE',tradingsymbol:'ABC',quantity:1,t1_quantity:0,average_price:10,last_price:10,pnl:0}]:[{symbol:'ABC',quantity:1,average_price:10,market_price:10,current_value:10}]};
const raw='100';if(raw!=='missing')snapshot[market==='india'?'available_margin':'wallet_balance']=raw==='null'?null:raw==='malformed'?'bad':Number(raw);
async function readSnapshot(){if(state==='loading')return new Promise(()=>{});if(state==='error')throw Error('Synthetic snapshot read failed');if(state==='empty')return {latest:null};if(state==='partial'){if(market==='india')snapshot.available_margin=null;else snapshot.reported_holdings_count=2;}return {latest:snapshot};}
const apiService={zerodhaPortfolioOverview:readSnapshot,indmoneyUsPortfolioOverview:readSnapshot,zerodhaThreatsLatest:async()=>({analysis:null}),indmoneyUsThreatsLatest:async()=>({analysis:null}),getRuns:async()=>({items:[]})};
${declarations}
function Fixture(){const[prompt,setPrompt]=useState('');const[selection,setOutputSourceSelection]=useState(null);return <Context.Provider value={{prompt,setPrompt,setOutputSourceSelection,selectedTargets:new Set(['fixture']),submitting:false}}><h1>{market==='india'?'India':'US'} Rebalance</h1><PortfolioAnalysisNav portfolio={market==='india'?'zerodha':'indmoneyUs'} active='rebalance'/><RebalanceInputBox portfolio={market==='india'?'zerodha':'indmoneyUs'} market={market} basePrompt='Synthetic rebalance prompt'/><pre data-testid='prompt'>{prompt}</pre><pre data-testid='selection'>{selection?.inputBundle||''}</pre></Context.Provider>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
let browser,server;const denied=[],errors=[],results=[];
try{
 await writeFile(path.join(temp,'entry.tsx'),entry);
 await writeFile(path.join(temp,'link.tsx'),`import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
 await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
 const w=require('next/dist/compiled/webpack/webpack');await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.ts','.tsx','.js'],modules:[path.join(root,'node_modules')],alias:{'@':root,'next/link$':path.join(temp,'link.tsx')}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(Error(s.toString({all:false,errors:true}))):resolve()));
 const css=(await postcss([tailwind({base:root})]).process(await readFile(root+'/app/globals.css','utf8'),{from:root+'/app/globals.css'})).css;const bundle=await readFile(path.join(temp,'bundle.js'));
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?bundle:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><div id="root"></div><script src="/bundle.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath()});
 const page=await browser.newPage();await page.clock.setFixedTime(new Date('2026-11-01T12:00:00Z'));page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();denied.push(route.request().url());return route.abort();});
 for(const market of ['india','us'])for(const state of ['loading','empty','error','partial','stale'])for(const width of [1180,390]){
  await page.setViewportSize({width,height:844});await page.goto(origin+'/?'+new URLSearchParams({market,state}));
  const heading=page.getByRole('heading',{name:(market==='india'?'India':'US')+' Rebalance',exact:true});await heading.waitFor();
  const readiness=page.getByRole('region',{name:'Rebalance readiness'});await readiness.waitFor();
  if(state==='loading')await readiness.getByText('Loading saved inputs…',{exact:true}).first().waitFor();
  else if(state==='stale'||(state==='empty'&&market==='india'))await readiness.getByText('Execution may proceed under the current input rules.',{exact:true}).waitFor();
  else await readiness.getByText('Execution blocked:',{exact:false}).waitFor();
  const copy=await readiness.innerText();
  assert.match(copy,market==='india'?/India holdings, when supplied/:/US holdings must pass/);
  if(market==='india')assert.doesNotMatch(copy,/US holdings must pass/);else assert.doesNotMatch(copy,/missing India snapshot is allowed/);
  await readiness.scrollIntoViewIfNeeded();await page.screenshot({path:output+'/'+market+'-'+state+'-'+width+'.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  results.push({market,state,width,copy});
 }
 assert.deepEqual(denied,[]);assert.deepEqual(errors,[]);
 await writeFile(output+'/result.json',JSON.stringify({finding:'DATA-ERROR-20261102-01',result:'PASS',cases:results.length,checks:['actual RebalanceInputBox caller and readiness','paired India/US loading/empty/error/partial/stale','India null snapshot remains allowed','US null snapshot remains blocked','market header and copy captured1180/390'],limitations:['Synthetic source reads; job submission/provider boundary excluded']},null,2));
 console.log('PASS market readiness20paired cases; no providers/submission '+output);
}finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
