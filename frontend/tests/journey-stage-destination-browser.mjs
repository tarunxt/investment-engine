// JOURNEY-RUNS-STAGE-DESTINATION: synthetic saved-history destination labels and Back context.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url).pathname;
const { webpack } = require('next/dist/compiled/webpack/webpack');
const sources = {}, external = new Set(['react', 'react-dom/client', 'react/jsx-runtime']);
function collect(file) {
  if (sources[file]) return file;
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  sources[file] = { code, deps: {} };
  for (const [, name] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (['next/link', '@/services/api'].includes(name)) continue;
    if (name.startsWith('@/') || name.startsWith('.')) {
      const base = name.startsWith('@/') ? name.slice(2) : path.join(path.dirname(file), name);
      const resolved = ['.ts', '.tsx'].map(ext => base + ext).find(candidate => existsSync(path.join(root, candidate)));
      if (!resolved) throw new Error('Unresolved ' + name);
      sources[file].deps[name] = collect(resolved);
    } else external.add(name);
  }
  return file;
}
const target = collect('app/console/runs/_components/PortfolioWorkflowHistoryCard.tsx');
const css = await postcss([tailwind({ base: root })]).process('@import "tailwindcss";', { from: path.join(root, 'app/globals.css') });
const temp = await mkdtemp(path.join(tmpdir(), 'runs-ledger-'));
const artifacts = '/tmp/journey-stage-destination-evidence';
await mkdir(artifacts, { recursive: true });
let browser;
try {
  await writeFile(path.join(temp, 'fixture.cjs'), `
const React = require(${JSON.stringify(require.resolve('react'))});
const {createRoot} = require(${JSON.stringify(require.resolve('react-dom/client'))});
const external = {${[...external].map(name => `${JSON.stringify(name)}:require(${JSON.stringify(require.resolve(name))})`).join(',')}};
const sources = ${JSON.stringify(sources)}, cache = {};
function load(id) {
 if (cache[id]) return cache[id].exports;
 const module = {exports:{}}; cache[id] = module;
 new Function('require','module','exports', sources[id].code)(name => {
   if (name === 'next/link') return {__esModule:true,default:({children,...props})=>React.createElement('a',props,children)};
   if (name === '@/services/api') return {apiService:{getRun:async id=>({id,status:'completed',run_jobs:[]})}};
   return sources[id].deps[name] ? load(sources[id].deps[name]) : external[name];
 },module,module.exports); return module.exports;
}
const Card = load(${JSON.stringify(target)}).PortfolioWorkflowHistoryCard;
const keys = ['sync','threats','swing','rebalance','technical','actionables'];
const fixtureParams = new URLSearchParams(location.search); const market = fixtureParams.get('market') || 'indmoney_us'; const state = fixtureParams.get('state') || 'partial';
const stages = keys.map((stage,i)=>({stage,run_id:i===3?459:null,status:i===1?'skipped':state==='error'?'failed':state==='loading'?'pending':state==='stale'?'completed':state,started_at:'2026-10-20T14:00:00Z',completed_at:'2026-10-20T14:02:00Z',provider_count:i===3?2:1,completed_provider_count:1,partial_provider_count:i===3?1:0,failed_provider_count:0,summary:{recommended_stocks:i*3,cost_inr:0,partial_notice:i===3?'Saved partial fixture output':null}}));
const group = {portfolio:market,sequence:122,label:market+' Run #122',status:state==='error'?'failed':state==='loading'?'running':state==='stale'?'completed':state,created_at:'2026-10-20T14:00:00Z',updated_at:'2026-10-20T14:02:00Z',stages};
const earlier = {...group,sequence:72,label:'IndMoney US Run #72',status:'failed',stages:[stages[0],{...stages[1],status:'failed',error_message:'Fixture failure'}]};
window.paths=[];
createRoot(document.getElementById('root')).render(React.createElement(Card,{group,runs:[{id:459,auto_rebalance_portfolio:market,auto_rebalance_sequence:122,status:'completed',prompt_preview:'fixture',run_jobs:[{}]}],adjacentGroups:[earlier],runLinksAvailable:state!=='loading',lastRefreshed:'14:03:00',initialView:'evidence',onOpen:path=>{window.paths.push(path);history.pushState(null,'',path)}}));
`);
  await new Promise((resolve, reject) => webpack({ mode:'none', target:'web', entry:path.join(temp,'fixture.cjs'), output:{path:temp,filename:'bundle.js'}, plugins:[new webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('test')})] }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({all:false,errors:true}))) : resolve()));
  browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1180,height:757}});
  const errors=[],externalRequests=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http://fixture.local/') ? route.fulfill({contentType:'text/html',body:`<style>${css.css}</style><main style="max-width:920px;margin:auto;padding:12px"><div id="root"></div></main>`}) : (externalRequests.push(route.request().url()), route.abort()));
  for (const market of ['india', 'indmoney_us']) {
    for (const state of ['loading', 'empty', 'error', 'partial', 'stale']) {
      const url = 'http://fixture.local/console/runs?market='+market+'&state='+state+'&selectedRun='+encodeURIComponent(market+':122')+'&runView=evidence';
      await page.goto(url); await page.addScriptTag({path:path.join(temp,'bundle.js')});
      const fallback = page.locator('div.border-t').filter({hasText:'Threats Scan'}).getByRole('button', {name:'View workflow context — no stage run', exact:true});
      await fallback.first().waitFor();
      const expected = '/console/auto-rebalance-runs/'+(market==='india'?'zerodha':'indmoneyUs')+'/122';
      await fallback.first().focus();
      assert.equal(await fallback.first().evaluate(n=>n===document.activeElement),true);
      await page.keyboard.press('Enter');
      await page.waitForURL('**'+expected);
      assert.equal(new URL(page.url()).pathname, expected);
      await page.goBack();
      assert.match(page.url(), /runView=evidence/);
      assert.equal(new URL(page.url()).searchParams.get('selectedRun'), market+':122');
      assert.equal(await page.getByRole('tab', {name:'Run 122 stage evidence',exact:true}).getAttribute('aria-selected'),'true');
      await page.getByRole('button',{name:'Open stage',exact:true}).click();
      assert.equal(new URL(page.url()).pathname, '/console/runs/459');
      await page.goBack();
      await page.getByRole('button',{name:'Saved output for Rebalance',exact:true}).click();
      assert.equal(new URL(page.url()).pathname, '/console/runs/459');
      await page.goBack();
      assert.deepEqual(await page.evaluate(()=>window.paths),[expected,'/console/runs/459','/console/runs/459']);
      await page.setViewportSize({width:390,height:757});
      const region=page.getByRole('region',{name:/stage evidence/});
      await region.focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await region.evaluate(n=>n===document.activeElement),true);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(artifacts,market+'-'+state+'-390.png'),fullPage:true});
      await page.setViewportSize({width:1180,height:757});
      await page.screenshot({path:path.join(artifacts,market+'-'+state+'-1180.png'),fullPage:true});
    }
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(externalRequests,[]);
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({task:'JOURNEY-RUNS-STAGE-DESTINATION',result:'PASS',markets:['india','indmoney_us'],syntheticStates:['loading','empty','error','partial','stale'],checks:['skipped Threats fallback label and exact workflow path','recorded Rebalance run and saved-output paths','keyboard activation','390px and 1180px','Back selectedRun/runView restoration'],externalRequests:0,limitations:['Offline actual-component fixture; destination page lifecycle and live-route acceptance not claimed']},null,2));
  console.log('PASS JOURNEY-RUNS-STAGE-DESTINATION both markets, five synthetic states, known/missing run paths, keyboard, narrow, Back context; '+artifacts);
} finally { await browser?.close(); await rm(temp,{recursive:true,force:true}); }
