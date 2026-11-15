import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack');
const frontend = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'us-snapshot-browser-'));
const evidence = process.env.TIME_EVIDENCE || '/tmp/portfolio-time-after';
let browser;
let css;
const alpha = { company_name: 'Fixture Alpha', symbol: 'FALP', market_price: 120, market_change_percent: 1.25, invested_value: 1000, quantity: 10, average_price: 100, current_value: 1200, total_pnl: 200, total_pnl_percent: 20, portfolio_weight_percent: 60, price_vs_average_percent: 20 };
const beta = { ...alpha, company_name: 'Fixture Beta', symbol: 'FBET', market_price: 80, market_change_percent: null, invested_value: 900, current_value: 800, average_price: 90, total_pnl: -100, total_pnl_percent: -11.11, portfolio_weight_percent: 40, price_vs_average_percent: -11.11 };
const snapshot = { id: 4, captured_at: '2026-10-20T14:49:00Z', snapshot_date: '2026-10-20', source: 'manual_paste', parse_status: 'partial', holdings_count: 2, reported_holdings_count: 3, indices_count: 1, wallet_balance: null, current_value: 2000, invested_value: 1900, day_return_value: null, day_return_percent: null, total_return_value: 100, total_return_percent: 5.26, holdings: [alpha, beta], market_indices: [{ name: 'Fixture index', value: 100, change_value: 1, change_percent: 1.01, raw_change_text: 'Synthetic context' }], raw_text: 'Local synthetic portfolio fixture — no live account values', parse_warnings: ['Fixture: totals do not reconcile.'], derived: { parsed_holdings_current_value: 2000, parsed_holdings_invested_value: 1900, parsed_holdings_total_pnl: 100, profitable_holdings_count: 1, loss_making_holdings_count: 1, reconciliation: [{ label: 'Holdings Count', summary_value: 3, parsed_value: 2, delta: -1 }], top_allocations: [alpha, beta], top_gainers: [alpha], top_laggards: [beta] } };

before(async () => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(temp, 'ts-loader.cjs'), `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;`);
  writeFileSync(join(temp, 'link.jsx'), `import React from 'react'; export default function Link({children,...props}) { return <a {...props}>{children}</a>; }`);
  writeFileSync(join(temp, 'entry.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PortfolioSnapshotsPanel as India} from ${JSON.stringify(join(frontend, 'app/console/zerodha/_components/PortfolioSnapshotsPanel.tsx'))}; import {IndMoneyUsSnapshotWorkspace as US} from ${JSON.stringify(join(frontend, 'app/console/indmoney-us/_components/IndMoneyUsSnapshotWorkspace.tsx'))}; const f=window.fixtureConfig; const props={...f.props,onSync:()=>{},onRefresh:async()=>{},onCreateSnapshot:async()=>{},onSelectSnapshot:()=>{}}; createRoot(document.getElementById('app')).render(f.market==='india'?<India {...props}/>:<US {...props}/>);`);
  const compiler = webpack({
    mode: 'development', devtool: false, context: frontend, entry: join(temp, 'entry.tsx'),
    output: { path: temp, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'], modules: [join(frontend, 'node_modules'), 'node_modules'], alias: { 'next/link$': join(temp, 'link.jsx'), '@': frontend } },
    module: { rules: [{ test: /\.(tsx?|jsx)$/, exclude: /node_modules/, use: join(temp, 'ts-loader.cjs') }] },
    plugins: [new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
    optimization: { minimize: false },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  css = (await postcss([tailwind()]).process('@import "tailwindcss";', { from: join(frontend, 'app/globals.css') })).css;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });


test('actual India and US labels in isolated states and widths',async()=>{
 for(const market of ['india','us']) for(const state of ['success','loading','empty','error','partial','stale','unknown-time']) for(const width of [1280,390]) {
 const page=await browser.newPage({viewport:{width,height:900},timezoneId:'America/New_York',deviceScaleFactor:1});
 const india={snapshot_date:'2026-10-20',captured_at:'2026-10-20T14:49:00Z',source:'login',holdings_count:0,net_positions_count:0,day_positions_count:0,holdings_market_value:2000,holdings_pnl:100,holdings_day_change_value:10,available_margin:500,positions_pnl:0,positions_m2m:0,holdings:[],positions:{net:[],day:[]}};
 const selected=market==='india'?india:{...snapshot,parse_status:state==='success'?'parsed':'partial'};
 if(state==='unknown-time') selected.captured_at='2026-10-20T14:49:00';
 const absent=['loading','empty','error'].includes(state);
 const props={connected:false,overview:state==='loading'?null:{latest:absent?null:selected,history:absent?[]:[selected]},selectedSnapshot:absent?null:selected,selectedSnapshotDate:selected.snapshot_date,selectedSnapshotId:selected.id,loading:state==='loading',selecting:state==='stale',syncing:false,saving:false,error:['error','stale'].includes(state)?'Synthetic read failure':null,loadError:['error','stale'].includes(state)?'Synthetic read failure':null,saveError:null};
 await page.addInitScript(value=>{window.fixtureConfig=value},{market,props});
 await page.route('**/*',route=>route.fulfill({contentType:route.request().url().endsWith('bundle.js')?'text/javascript':'text/html',body:route.request().url().endsWith('bundle.js')?readFileSync(join(temp,'bundle.js'),'utf8'):`<meta charset="utf-8"><style>${css}</style><main style="padding:16px"><div id="app"></div></main><script src="/bundle.js"></script>`}));
 await page.goto('http://fixture.test');await page.locator('#app > *').first().waitFor();
 await page.screenshot({path:join(evidence,`${market}-${state}-${width}.png`),fullPage:true});
 const text=await page.locator('main').innerText();
 writeFileSync(join(evidence,`${market}-${state}-${width}.json`),JSON.stringify({timestamp:new Date().toISOString(),width,deviceScaleFactor:1,text},null,2));
 if(process.env.TIME_AFTER !== '0' && ['success','partial','stale'].includes(state)) {
 assert.ok(await page.getByRole('status').count()>0,'capture status is announced');
 assert.match(text,/20 Oct 2026/);
 if(market==='us') assert.match(await page.getByText('Wallet',{exact:true}).locator('../..').innerText(),/—/);
 assert.match(text,/Captured/); assert.match(text,/8:19 pm IST/i); assert.match(text,/Price as-of unavailable in this view/); assert.match(text,/Save time unavailable in this view/);
 assert.match(text,market==='india'?/Available Margin/i:/Wallet/i);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no page overflow');
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement!==document.body),true,'keyboard target');
 }
 if(process.env.TIME_AFTER !== '0' && state==='unknown-time') {assert.match(text,/Not recorded \(timezone unknown\)/); assert.doesNotMatch(text,/8:19 pm/);}
 await page.close();
 }
});
