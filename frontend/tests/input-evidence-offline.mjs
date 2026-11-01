// Offline browser regression of the real picker, extracted without its workflow side effects.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { compile } from '@tailwindcss/node';

const root = resolve(import.meta.dirname, '..');
const temp = resolve(root, 'node_modules/.cache/input-evidence-test');
mkdirSync(temp, { recursive: true });
const workflow = readFileSync(resolve(root, 'app/console/dashboard/_components/RebalanceWorkflowSections.tsx'), 'utf8');
const rows = readFileSync(resolve(root, 'app/console/dashboard/_components/InputEvidenceRows.tsx'), 'utf8');
const dialog = workflow.slice(workflow.indexOf('function InputSelectionDialog('), workflow.indexOf('function AutoRebalanceCostHistoryDialog('));
const entry = `import React,{useState,useRef,useEffect,useMemo,useId} from 'react';
import {createRoot} from 'react-dom/client';
import {InputEvidenceRows,InputEvidenceSummary} from '${resolve(root, 'app/console/dashboard/_components/InputEvidenceRows.tsx')}';
const Button=(p)=><button {...p}/>; const X=()=> <span>×</span>;
const parseTimestampMs=(s)=>Date.parse(s)||0; const formatTimestamp=(s)=>s;
${dialog}
const next={id:'threats:next',source:'next',label:'Upcoming portfolio snapshot',timestamp:null,status:'reserved',error:null,jobNo:'Upcoming run'};
const saved={id:'portfolio:zerodha:latest',source:'run-job',label:'Latest Zerodha portfolio snapshot',timestamp:'2026-10-31T12:00:00Z',status:'partial',error:'Some holdings unavailable',jobNo:'Latest snapshot'};
function Fixture(){const[open,setOpen]=useState(false);const[selected,setSelected]=useState(new Set([next.id]));const[state,setState]=useState('loaded');
const candidates=state==='empty'?[]:state==='missing'?[next]:[next,saved];
return <main><button onClick={()=>setOpen(true)}>Choose evidence</button><select aria-label="Fixture state" value={state} onChange={e=>setState(e.target.value)}>{['loaded','loading','empty','missing','failed'].map(s=><option key={s}>{s}</option>)}</select><InputSelectionDialog open={open} stage="threats" candidates={candidates} selectedIds={selected} usdInrRate={83} loading={state==='loading'} error={state==='failed'?'Fixture read failed':null} onClose={()=>setOpen(false)} onToggle={id=>setSelected(old=>{const n=new Set(old);n.has(id)?n.delete(id):n.add(id);return n})} onToggleAll={()=>setSelected(candidates.every(c=>selected.has(c.id))?new Set():new Set(candidates.map(c=>c.id)))} onResetDefaults={()=>setSelected(new Set([next.id]))}/></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
writeFileSync(resolve(temp, 'fixture.tsx'), entry);
execFileSync('npm', ['exec', '--yes', '--cache', '/tmp/auto-inputs-npm', '--package', 'esbuild', '--', 'esbuild', resolve(temp, 'fixture.tsx'), '--bundle', '--jsx=automatic', '--outfile='+resolve(temp,'fixture.js')], { cwd: root, stdio: 'pipe' });
const compiler = await compile('@import "tailwindcss";', {base:root,onDependency:()=>{}});
const candidates = [...(dialog+rows).matchAll(/className="([^"]+)"/g)].flatMap(match=>match[1].split(/\s+/));
const css=compiler.build(candidates);
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<style>${css}</style><div id="root"></div><script>${readFileSync(resolve(temp,'fixture.js'),'utf8')}</script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1180,height:757}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const open=()=>page.getByRole('button',{name:'Choose evidence',exact:true}).click();
  const summary=page.getByRole('status');
  await open();
  assert.match(await summary.innerText(),/Upcoming output/);
  assert.doesNotMatch(await summary.innerText(),/Saved snapshot/);
  assert.equal(await page.getByRole('checkbox',{name:'Include Saved snapshot',exact:true}).isChecked(),false);
  await page.getByRole('checkbox',{name:'Include Saved snapshot',exact:true}).check();
  assert.match(await summary.innerText(),/Upcoming output · Saved snapshot/);
  assert.match(await page.getByRole('dialog').innerText(),/Existing snapshot · partial/);
  assert.match(await page.getByRole('dialog').innerText(),/2026-10-31T12:00:00Z/);
  assert.match(await page.getByRole('dialog').innerText(),/Some holdings unavailable/);
  await page.getByRole('checkbox',{name:'Include Upcoming output',exact:true}).uncheck();
  assert.doesNotMatch(await summary.innerText(),/Upcoming output/);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Choose evidence',exact:true}).evaluate(e=>document.activeElement===e),true);
  await open();assert.match(await summary.innerText(),/Saved snapshot/);
  await page.getByRole('button',{name:'Reset defaults',exact:true}).click();
  assert.doesNotMatch(await summary.innerText(),/Saved snapshot/);
  await page.getByRole('checkbox',{name:'Select or deselect all inputs',exact:true}).check();
  assert.match(await summary.innerText(),/Upcoming output · Saved snapshot/);
  await page.getByRole('checkbox',{name:'Select or deselect all inputs',exact:true}).uncheck();
  assert.match(await summary.innerText(),/No available sources selected/);
  await page.getByRole('button',{name:'Reset defaults',exact:true}).click();
  await page.getByRole('button',{name:'Close input selection',exact:true}).focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button',{name:'Done',exact:true}).evaluate(e=>document.activeElement===e),true);
  await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Close input selection',exact:true}).evaluate(e=>document.activeElement===e),true);
  const evidence=process.env.EVIDENCE_DIR || '/tmp/auto-inputs-evidence';mkdirSync(evidence,{recursive:true});
  await page.screenshot({path:resolve(evidence,'desktop-1180x757.png')});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:resolve(evidence,'narrow-390x844.png')});
  await page.getByRole('checkbox',{name:'Include Saved snapshot',exact:true}).scrollIntoViewIfNeeded();
  await page.getByRole('checkbox',{name:'Include Saved snapshot',exact:true}).check();
  assert.match(await summary.innerText(),/Upcoming output · Saved snapshot/);
  await page.keyboard.press('Escape');
  for(const state of ['loading','empty','missing','failed']){
    await page.getByRole('combobox',{name:'Fixture state'}).selectOption(state);await open();
    const text=await page.getByRole('dialog').innerText();
    assert.match(text,({loading:/Loading evidence sources/,empty:/No eligible sources/,missing:/Saved snapshot unavailable/,failed:/Fixture read failed/})[state]);
    if(state==='empty') assert.match(await summary.innerText(),/2 selected sources are unavailable/);
    if(state==='missing') assert.match(await summary.innerText(),/1 selected source is unavailable/);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: selection, select-all/reset, partial/stale timestamp, loading/empty/missing/failed, repeated open/close, Escape/focus return, Tab containment, desktop/narrow overflow.');
} finally {await browser.close();await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true});}
