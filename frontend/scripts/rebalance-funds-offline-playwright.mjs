#!/usr/bin/env node
// Offline browser: unchanged production input component and synthetic API/context.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'rebalance-funds-'));
const source=await readFile(path.join(root,'app/console/_components/PortfolioRebalanceConsole.tsx'),'utf8');
const ast=ts.createSourceFile('component.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations=ast.statements.filter(n=>!ts.isImportDeclaration(n)&&!ts.isExpressionStatement(n)&&n.getStart(ast)<source.indexOf('export function PortfolioRebalanceConsole')).map(n=>n.getText(ast)).join('\n');
const entry=`import React,{useState,useEffect,useMemo,useCallback,useRef,createContext,useContext} from 'react';
import {createRoot} from 'react-dom/client';
import {AlertCircle,BriefcaseBusiness,ChevronDown,ChevronUp,RefreshCw,ShieldAlert,TrendingUp} from 'lucide-react';
import {Button} from '@/components/ui/button';import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {RebalanceReadiness} from '@/app/console/_components/RebalanceReadiness';
import {buildRebalanceInputBundle,REBALANCE_INPUT_SECTION_MARKERS,getPreviousMarketClose} from '@/lib/rebalance';
import {isRunInSwingTradeMarket} from '@/lib/runPresentation';
const CreateJobCard=()=>null; // Submission boundary excluded: no jobs or paid calls.
const Context=createContext(null);const useDashboard=()=>useContext(Context);
const params=new URL(location.href).searchParams,market=params.get('market')||'india';
const snapshot={snapshot_date:'2020-01-01',captured_at:'2020-01-01T00:00:00Z',parse_status:'parsed',reported_holdings_count:1,holdings:market==='india'?[{exchange:'NSE',tradingsymbol:'ABC',quantity:1,t1_quantity:0,average_price:10,last_price:10,pnl:0}]:[{symbol:'ABC',quantity:1,average_price:10,market_price:10,current_value:10}]};
const raw=params.get('value');if(raw!=='missing')snapshot[market==='india'?'available_margin':'wallet_balance']=raw==='null'?null:raw==='malformed'?'bad':Number(raw);
async function readSnapshot(){if(params.has('error'))throw Error('Synthetic snapshot read failed');return {latest:snapshot};}
const apiService={zerodhaPortfolioOverview:readSnapshot,indmoneyUsPortfolioOverview:readSnapshot,zerodhaThreatsLatest:async()=>({analysis:null}),indmoneyUsThreatsLatest:async()=>({analysis:null}),getRuns:async()=>({items:[]})};
${declarations}
function Fixture(){const[prompt,setPrompt]=useState('');const[selection,setOutputSourceSelection]=useState(null);return <Context.Provider value={{prompt,setPrompt,setOutputSourceSelection,selectedTargets:new Set(['fixture']),submitting:false}}><RebalanceInputBox portfolio={market==='india'?'zerodha':'indmoneyUs'} market={market} basePrompt='Synthetic rebalance prompt'/><pre data-testid='prompt'>{prompt}</pre><pre data-testid='selection'>{selection?.inputBundle||''}</pre></Context.Provider>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
let browser,server;const denied=[],errors=[],results=[];
try{
 await writeFile(path.join(temp,'entry.tsx'),entry);
 await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
 const w=require('next/dist/compiled/webpack/webpack');await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.ts','.tsx','.js'],modules:[path.join(root,'node_modules')],alias:{'@':root}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(Error(s.toString({all:false,errors:true}))):resolve()));
 const bundle=await readFile(path.join(temp,'bundle.js'));
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:'<div id="root"></div><script src="/bundle.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
 const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();denied.push(route.request().url());return route.abort();});
 for(const market of ['india','us'])for(const value of ['missing','null','malformed','0','-5','0.125','100']){
  await page.goto(origin+'/?'+new URLSearchParams({market,value}));
  await page.getByTestId('prompt').filter({hasText:'rebalance-funds/v1'}).waitFor();
  await page.getByRole('button',{name:/Input Box/}).click();
  const portfolio=page.locator('section').filter({has:page.getByRole('heading',{name:'Portfolio',exact:true})}).locator('pre');
  const preview=await portfolio.textContent(),prompt=await page.getByTestId('prompt').textContent(),selection=await page.getByTestId('selection').textContent();
  const expected=['missing','null','malformed'].includes(value)?'Unknown (missing or invalid)':String(Number(value));
  const line='snapshot.'+(market==='india'?'available_margin; currency: INR':'wallet_balance; currency: USD')+'; stored value: '+expected;
  for(const text of [preview,prompt,selection])for(const part of [line,'captured at: 2020-01-01T00:00:00Z','not a live funds refresh','no deployable-budget rule',market==='india'?'does not prove broker-confirmed zero':'Buying power and margin are unknown'])assert.ok(text.includes(part),part);
  assert.ok(prompt.includes(preview));assert.ok(selection.includes(preview));
  await page.getByText('Combined prompt input context',{exact:true}).click();assert.ok((await page.locator('details textarea').inputValue()).includes(preview));
  await page.getByRole('button',{name:'Refresh Inputs',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Refresh Inputs')&&!b.disabled));await page.getByTestId('prompt').filter({hasText:line}).waitFor();assert.equal(await portfolio.textContent(),preview);
  await page.getByRole('button',{name:/Input Box/}).click();await page.getByRole('button',{name:/Input Box/}).click();assert.equal(await portfolio.textContent(),preview);results.push(market+':'+value);
 }
 await page.goto(origin+'/?market=india&value=100&error=1');await page.getByText('Synthetic snapshot read failed',{exact:false}).first().waitFor();assert.equal(await page.getByTestId('prompt').textContent(),'');assert.equal(await page.getByTestId('selection').textContent(),'');results.push('error: no prompt/selection');
 assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);console.log(JSON.stringify({kind:'actual component offline browser fixtures',passed:results.length,results,externalRequests:0,providerCalls:0},null,2));
}finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
