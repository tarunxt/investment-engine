// A10-S02: actual UI components and controls with synthetic data and no external requests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'a10-ui-'));
const output = process.env.A10_UI_EVIDENCE_DIR || '/tmp/audit10-ui-evidence';
await mkdir(output, { recursive: true });
const components = `${frontend}/app/console/bullpen-ai/analyse-events/_components`;
await writeFile(`${temp}/entry.tsx`, `import React from 'react';import{createRoot}from'react-dom/client';import{TradeAnalysisListClient}from'${components}/TradeAnalysisListClient';import{TradeAnalysisDetailClient}from'${components}/TradeAnalysisDetailClient';createRoot(document.getElementById('root')).render(location.hash==='#detail'?<TradeAnalysisDetailClient/>:<TradeAnalysisListClient/>);`);
await writeFile(`${temp}/api.ts`, `const read=()=>new Promise((resolve,reject)=>window.requests.push({resolve,reject}));export const apiService=new Proxy({bullpenAiTradeAnalysis:read,bullpenAiTradeAnalysisDetail:read},{get:(target,key)=>target[key]||(()=>{window.writes++;throw Error('Blocked '+String(key))})});`);
await writeFile(`${temp}/auth.ts`, `export const useAuth=()=>({user:{id:123}});`);
await writeFile(`${temp}/link.tsx`, `import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
await writeFile(`${temp}/nav.ts`, `export const useParams=()=>({tradeId:'synthetic'});`);
await build({ entryPoints: [`${temp}/entry.tsx`], bundle: true, outfile: `${temp}/bundle.js`, platform: 'browser', jsx: 'automatic', nodePaths: [`${frontend}/node_modules`], alias: { '@/services/api': `${temp}/api.ts`, '@/hooks/useAuth': `${temp}/auth.ts`, 'next/link': `${temp}/link.tsx`, 'next/navigation': `${temp}/nav.ts`, '@': frontend }, define: { 'process.env.NODE_ENV': '"development"' } });
const css = (await postcss([tailwind({ base: frontend })]).process(await readFile(`${frontend}/app/globals.css`, 'utf8'), { from: `${frontend}/app/globals.css` })).css;
const bundle = await readFile(`${temp}/bundle.js`);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.requests=[];window.writes=0;</script><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const external = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : (external.push(route.request().url()), route.abort()));
  page.on('pageerror', error => errors.push(error.message));
  const open = async (hash = '') => { await page.goto('about:blank'); await page.goto(`${base}/${hash}`); await page.waitForFunction(() => window.requests.length === 1); };
  const resolve = async data => { await page.evaluate(value => window.requests.shift().resolve(value), data); };
  const response = {
    items: [{ id: 'synthetic-loss', title: 'Synthetic loss', status: 'SOLD', final_tag: 'LOSS', pnl_outcome_tag: 'LOSS', is_squared_off: true, buy_tags: [], confidence: null, net_pnl: null, fees_total: null }],
    summary: { total_executed_trades: 1, open_positions: 0, closed_positions: 1, total_net_pnl: 0, total_fees: 0, win_rate: 0, average_pnl_percent: null, average_holding_period_seconds: null },
    learning_insights: { win_rate_by_tag: [], average_pnl_by_tag: [], total_pnl_by_strategy_version: [], recommendations: [], profitable_tags: [], unprofitable_tags: [], exit_reasons_ranked_by_pnl: [], buy_reasons_ranked_by_pnl: [], average_pnl_by_confidence_bucket: [], average_pnl_by_liquidity_bucket: [] },
  };
  await open();
  await resolve(response);
  await page.getByText('Confidence: Not evaluated', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Trades', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByText('Descriptive observations only.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Learning Insights' }).getAttribute('aria-selected'), 'true');
  const disclosure = page.getByText('Learning Insights JSON', { exact: true });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.evaluate(node => node.parentElement.open), true);
  await page.screenshot({ path: `${output}/learning-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/learning-narrow.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  // Same applied filters + failed refresh must show the dated cache notice.
  await page.getByLabel('Topic', { exact: true }).fill('synthetic');
  await page.getByLabel('Topic', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  await page.waitForFunction(() => window.requests.length === 1);
  await page.evaluate(() => window.requests.shift().reject(new Error('Synthetic failed refresh')));
  await page.getByText('Live refresh failed; showing saved trade analysis', { exact: false }).waitFor();
  await page.screenshot({ path: `${output}/stale-narrow.png`, fullPage: true });
  // New page and cleared cache establish an independent failed-read state.
  await page.evaluate(() => sessionStorage.clear());
  await open();
  await page.evaluate(() => window.requests.shift().reject(new Error('Synthetic unavailable')));
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Learning Insights' }).click();
  assert.equal(await page.getByText('Learning insights unavailable.', { exact: true }).count() > 0, true);
  assert.equal(await page.getByText('No observations in this category.', { exact: true }).count(), 0);
  await page.screenshot({ path: `${output}/failed-narrow.png`, fullPage: true });
  await open('#detail');
  await page.getByRole('status').waitFor();
  await resolve({ trade: { id: 'synthetic', title: 'Synthetic equal-price exit', buy_price: 0.5, exit_price: 0.5, buy_confidence: null, sell_confidence: null }, comparison: {}, actionable_learning: { exit_timing: 'EARLY_EXIT', llm_confidence_aligned: true, what_worked: [], what_went_wrong: [], suggested_platform_rule_changes: [], suggested_prompt_changes: [], suggested_risk_management_changes: [] }, snapshots: [], llm_entries: [], event_logs: [] });
  await page.getByText('Exit timing: Not evaluated.', { exact: false }).waitFor();
  await page.getByText('LLM confidence aligned: Not evaluated.', { exact: false }).waitFor();
  await page.getByText('Stored Learning Raw Evidence', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.screenshot({ path: `${output}/detail-narrow.png`, fullPage: true });
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.writes), 0);
  await writeFile(`${output}/result.json`, JSON.stringify({ task: 'A10-S02', result: 'PASS', externalRequests: external.length, pageErrors: errors.length, mutationCalls: 0, checks: ['actual list/detail rendering', 'unknown confidence', 'equal-price unevaluated exit', 'keyboard tabs and disclosure', '390px viewport', 'failed read versus empty learning', 'dated cache on failed refresh'], limitations: ['Synthetic local fixtures only', 'Contract-dependent coverage and exit evaluation pending', 'No production navigation or deployment'] }, null, 2));
  console.log(`PASS offline A10-S02 UI fixtures: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
