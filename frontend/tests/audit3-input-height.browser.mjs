// Actual shared input picker, synthetic records only. No application/API execution.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'audit3-input-height-'));
const out = process.env.A3_HEIGHT_EVIDENCE || '/tmp/audit3-input-height-evidence';
await mkdir(out, { recursive: true });
const source = await readFile(root + '/app/console/dashboard/_components/RebalanceWorkflowSections.tsx', 'utf8');
const ast = ts.createSourceFile('workflow.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['InputSelectionDialog', 'formatTimestamp', 'getInputStatusBadgeClass', 'getInputMarketLabel', 'getInputMarketBadgeClass'];
const extracted = names.map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}).join('\n');
const entry = `import React,{useState,useRef,useEffect,useMemo,useId} from 'react';
import {createRoot} from 'react-dom/client';
import {X,Loader2,ChevronDown,ChevronRight} from 'lucide-react';
import {ModelPickerDialogFrame} from '${root}/components/shared/ModelPickerDialogFrame';
import {getStageTileLabel,parseTimestampMs} from '${root}/components/shared/WorkflowStageTile';
import {getAutoRebalanceRunDisplayLabel} from '${root}/lib/runPresentation';
import {formatUsdAsVerifiedInr} from '${root}/lib/fxPresentation';
import {URLs} from '${root}/lib/urls';
import {formatApiTimestamp} from '${root}/lib/datetime';
const INDIA_TIMEZONE='Asia/Kolkata';
import {InputEvidenceRows,InputEvidenceSummary} from '${root}/app/console/dashboard/_components/InputEvidenceRows';
import {threatInputRationale} from '${root}/app/console/dashboard/_components/threatInputRationale';
const cn=(...values)=>values.filter(Boolean).join(' ');const Button=props=><button {...props}/>;const Link=({children,...props})=><a {...props}>{children}</a>;
${extracted}
function Fixture(){const[open,setOpen]=useState(false),[stage,setStage]=useState('technical'),[market,setMarket]=useState('us'),[state,setState]=useState('loaded'),[selected,setSelected]=useState(new Set(['saved-0']));
const records=Array.from({length:8},(_,i)=>({id:'saved-'+i,source:'run-job',market,label:'Synthetic saved context '+i,jobNo:'Job '+(100+i),timestamp:'2020-01-01T12:00:00Z',status:i===0?'partial':'completed',costUsd:i===0?null:0,error:i===0?'Synthetic retained partial detail':null,run:{id:100+i,auto_rebalance_label:'Synthetic Run '+i,created_at:'2020-01-01T12:00:00Z'}}));
const candidates=state==='empty'?[]:records;
return <main><button onClick={()=>setOpen(true)}>Open input picker</button><select aria-label='Fixture stage' value={stage} onChange={e=>setStage(e.target.value)}>{['technical','threats','swing','rebalance','actionables'].map(s=><option key={s}>{s}</option>)}</select><select aria-label='Fixture market' value={market} onChange={e=>setMarket(e.target.value)}><option>us</option><option>india</option></select><select aria-label='Fixture state' value={state} onChange={e=>setState(e.target.value)}>{['loaded','loading','failed','empty'].map(s=><option key={s}>{s}</option>)}</select><InputSelectionDialog open={open} stage={stage} candidates={candidates} selectedIds={selected} usdInrRate={83} loading={state==='loading'} error={state==='failed'?'Synthetic source read failed':null} onClose={()=>setOpen(false)} onToggle={id=>setSelected(old=>{const n=new Set(old);n.has(id)?n.delete(id):n.add(id);return n})} onToggleAll={()=>setSelected(new Set(candidates.map(c=>c.id)))} onResetDefaults={()=>setSelected(new Set(['saved-0']))}/></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const result = await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', alias: { '@': root }, define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' } });
const css = (await postcss([tailwind({ base: root })]).process(await readFile(root + '/app/globals.css', 'utf8'), { from: root + '/app/globals.css' })).css;
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? result.outputFiles[0].text : `<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><style>${css}</style><div id='root'></div><script src='/fixture.js'></script>`); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const context = await chromium.launchPersistentContext(temp + '/profile', { executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], viewport: { width: 642, height: 756 } });
const page = await context.newPage(); const errors = [], external = [], receipts = [];
page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
try {
  for (const scenario of (process.env.A3_BASELINE_ONLY ? [{ name: 'native200', width: 642, height: 756, zoom: 2 }] : [{ name: 'desktop', width: 1180, height: 757, zoom: 1 }, { name: 'narrow', width: 390, height: 844, zoom: 1 }, { name: 'native200', width: 642, height: 756, zoom: 2 }])) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto('chrome://settings/appearance');
    await page.evaluate(zoom => chrome.settingsPrivate.setDefaultZoom(zoom), scenario.zoom);
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : (external.push(route.request().url()), route.abort()));
    await page.goto(origin + '/console/indmoney-us#us-workflow');
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    if (scenario.zoom === 2) { assert.equal(viewport.width, 321); assert.equal(viewport.height, 378); assert.equal(viewport.dpr, 2); }
    for (const stage of (process.env.A3_BASELINE_ONLY ? ['technical'] : ['technical', 'threats', 'swing', 'rebalance', 'actionables'])) for (const market of (process.env.A3_BASELINE_ONLY ? ['us'] : ['us', 'india'])) {
      await page.getByLabel('Fixture stage').selectOption(stage); await page.getByLabel('Fixture market').selectOption(market);
      for (const state of (process.env.A3_BASELINE_ONLY ? ['loaded'] : ['loaded', 'loading', 'failed', 'empty'])) {
        await page.getByLabel('Fixture state').selectOption(state); const opener = page.getByRole('button', { name: 'Open input picker', exact: true });
        await opener.focus(); await page.keyboard.press('Enter'); const dialog = page.getByRole('dialog'); await dialog.waitFor();
        const scroller = dialog.locator('[aria-label="Input sources and controls"]').or(dialog.locator('div.min-h-0.flex-1.overflow-auto')).first();
        const metrics = await scroller.evaluate(n => ({ clientHeight: n.clientHeight, scrollHeight: n.scrollHeight }));
        if (process.env.A3_BASELINE_ONLY) { assert.ok(metrics.clientHeight < 50, JSON.stringify(metrics)); receipts.push({ scenario, viewport, stage, market, state, metrics }); continue; }
        assert.ok(metrics.clientHeight >= 80, JSON.stringify({ viewport, stage, metrics }));
        assert.ok(await dialog.evaluate(n => n.contains(document.activeElement)));
        await page.getByRole('button', { name: 'Done', exact: true }).focus(); await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('button', { name: 'Close input selection', exact: true }).evaluate(n => n === document.activeElement), true);
        await page.keyboard.press('Shift+Tab'); assert.equal(await page.getByRole('button', { name: 'Done', exact: true }).evaluate(n => n === document.activeElement), true);
        if (state === 'loaded' && stage !== 'threats') {
          const last = dialog.getByRole('button', { name: /(Expand|Collapse).*Synthetic Run 7/ }); await last.scrollIntoViewIfNeeded(); if (await last.getAttribute('aria-expanded') !== 'true') await last.click();
          const selection = dialog.getByRole('checkbox', { name: 'Select Synthetic saved context 7', exact: true });
          await selection.scrollIntoViewIfNeeded(); await selection.focus(); assert.equal(await selection.evaluate(n => n === document.activeElement), true);
          assert.match(await dialog.innerText(), /Job 107/); assert.match(await dialog.innerText(), /₹0/);
        }
        await scroller.evaluate(n => { n.scrollTop = n.scrollHeight; });
        if (state === 'loaded') assert.ok(await scroller.evaluate(n => n.scrollTop > 0));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (scenario.zoom === 2 && stage === 'technical' && market === 'us' && state === 'loaded') await page.screenshot({ path: out + '/technical-native200.png' });
        await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await opener.evaluate(n => n === document.activeElement), true);
        receipts.push({ scenario: scenario.name, viewport, stage, market, state, metrics });
      }
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(out + '/results.json', JSON.stringify({ finding: 'ACCESS-Rebalance-Inputs-NarrowContentHeight', source: process.env.A3_BASELINE_ONLY ? 'unmodified live dialog' : 'candidate', receipts, errors, external, operations: 0 }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', cases: receipts.length, nativeZoom200: receipts.filter(x => x.viewport.dpr === 2), operations: 0 }));
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
