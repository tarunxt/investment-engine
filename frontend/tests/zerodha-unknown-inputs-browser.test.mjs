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
const temp = mkdtempSync(join(tmpdir(), 'zerodha-numeric-browser-'));
const evidence = '/tmp/audit7-zerodha-numerics';
let browser;
let css;
before(async () => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(temp, 'ts-loader.cjs'), `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;`);
  writeFileSync(join(temp, 'link.jsx'), `import React from 'react'; export default function Link({children,...props}) { return <a {...props}>{children}</a>; }`);
  writeFileSync(join(temp, 'entry.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PortfolioSnapshotsPanel as India} from ${JSON.stringify(join(frontend, 'app/console/zerodha/_components/PortfolioSnapshotsPanel.tsx'))}; const f=window.fixtureConfig; const props={...f.props,onSync:()=>{},onRefresh:async()=>{},onCreateSnapshot:async()=>{},onSelectSnapshot:()=>{}}; createRoot(document.getElementById('app')).render(<India {...props}/>);`);
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


test('actual India unknown and zero numerics across repeated states',async()=>{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [1280,390]) for(const state of ['unknown','zero','partial','stale','loading','error','empty','zero','unknown']) {
 await page.setViewportSize({width,height:900});
 const value=state==='zero'?0:null;
 const holding={tradingsymbol:'SYNTH_HOLD',exchange:'NSE',quantity:value,t1_quantity:value,average_price:value,last_price:value,market_value:value,pnl:value,day_change_value:value};
 const position={tradingsymbol:'SYNTH_POS',exchange:'NFO',product:'NRML',quantity:value,average_price:value,last_price:value,pnl:value,m2m:value,day_buy_quantity:value,day_sell_quantity:value,realised:value,unrealised:value};
 if(state==='partial'){holding.quantity=2;holding.last_price=10;holding.market_value=20;}
 const selected={snapshot_date:'2026-10-20',captured_at:'2026-10-20T14:49:00Z',source:'synthetic',holdings_count:1,net_positions_count:1,day_positions_count:1,holdings_market_value:20,holdings_pnl:0,holdings_day_change_value:0,available_margin:value,positions_pnl:0,positions_m2m:0,holdings:[holding],positions:{net:[position],day:[position]}};
 const absent=['empty','error','loading'].includes(state);
 const props={connected:false,overview:{latest:absent?null:selected,history:absent?[]:[selected]},selectedSnapshot:absent?null:selected,selectedSnapshotDate:selected.snapshot_date,loading:state==='loading',selecting:state==='stale',syncing:false,error:['stale','error'].includes(state)?'Synthetic interrupted read':null};
 await page.unrouteAll();
 await page.route('**/*',route=>route.fulfill({contentType:route.request().url().endsWith('bundle.js')?'text/javascript':'text/html',body:route.request().url().endsWith('bundle.js')?readFileSync(join(temp,'bundle.js'),'utf8'):`<meta charset="utf-8"><style>${css}</style><main><div id="app"></div></main><script>window.fixtureConfig=${JSON.stringify({market:'india',props})}</script><script src="/bundle.js"></script>`}));
 await page.goto('http://fixture.test');await page.locator('#app > *').first().waitFor();
 if(!absent){
 const margin=await page.getByText('Available Margin',{exact:true}).locator('../..').innerText();
 assert.match(margin,state==='zero'?/₹0\.00/:/—/);
 const cells=await page.getByRole('row').filter({hasText:'SYNTH_HOLD'}).locator('td').allTextContents();
 assert.equal(cells[1].trim(),state==='zero'?'0':state==='partial'?'2':'—');
 assert.equal(cells[2].trim(),state==='zero'?'0.00':'—');
 const positions=page.getByRole('row').filter({hasText:'SYNTH_POS'});
 const net=await positions.first().locator('td').allTextContents();
 assert.equal(net[3].trim(),state==='zero'?'0.00':'—');
 const day=await positions.last().locator('td').allTextContents();
 assert.equal(day[1].trim(),state==='zero'?'0':'—');
 await page.getByRole('button',{name:'Qty',exact:true}).first().click();
 await page.getByRole('button',{name:'Qty',exact:true}).first().click();
 } else if(state==='loading') assert.match(await page.locator('main').innerText(),/Loading portfolio history/);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:join(evidence,`${state}-${width}.png`),fullPage:true});
 }
 await page.close();
});
