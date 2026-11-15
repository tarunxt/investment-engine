// Local-only interaction and screenshot fixture. No backend or live refreshes.
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
const artifacts = '/workspace/scratch/runs-stages-evidence';
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
const stages = keys.map((stage,i)=>({stage,run_id:i===3?801:null,status:i===3?'partial':'completed',started_at:'2026-10-20T14:00:00Z',completed_at:'2026-10-20T14:02:00Z',provider_count:i===3?2:1,completed_provider_count:1,partial_provider_count:i===3?1:0,failed_provider_count:0,summary:{recommended_stocks:i*3,cost_inr:0,partial_notice:i===3?'Saved partial fixture output':null}}));
const group = {portfolio:'indmoney_us',sequence:73,label:'IndMoney US Run #73',status:'completed',created_at:'2026-10-20T14:00:00Z',updated_at:'2026-10-20T14:02:00Z',stages};
const earlier = {...group,sequence:72,label:'IndMoney US Run #72',status:'failed',stages:[stages[0],{...stages[1],status:'failed',error_message:'Fixture failure'}]};
window.paths=[];
createRoot(document.getElementById('root')).render(React.createElement(Card,{group,runs:[{id:801,auto_rebalance_portfolio:'indmoney_us',auto_rebalance_sequence:73,status:'completed',prompt_preview:'fixture',run_jobs:[{}]}],adjacentGroups:[earlier],lastRefreshed:'14:03:00',onOpen:path=>window.paths.push(path)}));
`);
  await new Promise((resolve, reject) => webpack({ mode:'none', target:'web', entry:path.join(temp,'fixture.cjs'), output:{path:temp,filename:'bundle.js'}, plugins:[new webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('test')})] }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({all:false,errors:true}))) : resolve()));
  browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1180,height:757}});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http://fixture.local/') ? route.fulfill({contentType:'text/html',body:`<style>${css.css}</style><main style="max-width:920px;margin:auto;padding:12px"><div id="root"></div></main>`}) : route.abort());
  await page.goto('http://fixture.local/console/runs?tab=indmoney');
  await page.addScriptTag({path:path.join(temp,'bundle.js')});
  const tabs = page.getByRole('tab');
  await page.getByRole('tab', {name:'Run summary',exact:true}).waitFor();
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'),'true');
  await page.screenshot({path:path.join(artifacts,'summary-1180.png'),fullPage:true});
  await tabs.nth(0).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
  assert.match(page.url(),/selectedRun=indmoney_us%3A73/);
  assert.equal(await page.locator('tbody tr').count(),6);
  await page.screenshot({path:path.join(artifacts,'evidence-1180.png'),fullPage:true});
  await page.getByRole('button',{name:'Prompt for Rebalance',exact:true}).click();
  await page.getByRole('button',{name:'Saved output for Rebalance',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.paths),['/console/runs/801','/console/runs/801']);
  const errorButton=page.getByRole('button',{name:/Show error details/});
  for(let i=0;i<2;i++) { await errorButton.click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'}); assert.equal(await errorButton.evaluate(n=>n===document.activeElement),true); }
  const duration=page.getByRole('button',{name:/Show duration breakdown/}).first();
  for(let i=0;i<2;i++) { await duration.click(); await page.getByText(/duration breakdown/i).last().waitFor(); await page.keyboard.press('Escape'); }
  await tabs.nth(2).click();
  assert.match(await page.getByRole('tabpanel').innerText(),/Run #801/);
  assert.match(await page.getByRole('tabpanel').innerText(),/Swing Scan: Not recorded/);
  await page.screenshot({path:path.join(artifacts,'diagnostics-1180.png'),fullPage:true});
  await page.goBack(); assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
  await page.setViewportSize({width:390,height:757});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const region=page.getByRole('region', {name:/stage evidence/}); await region.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('[role=region]').scrollLeft>0);
  await page.screenshot({path:path.join(artifacts,'evidence-390.png'),fullPage:true});
  const deepLink=page.url();
  await page.goto(deepLink); await page.addScriptTag({path:path.join(temp,'bundle.js')});
  await page.waitForFunction(()=>document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('stage evidence'));
  assert.deepEqual(errors,[]);
  console.log('PASS: summary/evidence/diagnostics, keyboard tabs, Back, dialogs repeated twice, narrow overflow; screenshots '+artifacts);
} finally { await browser?.close(); await rm(temp,{recursive:true,force:true}); }
