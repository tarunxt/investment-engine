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
const evidence = '/tmp/us-snapshot-evidence-v2';
let browser;
let css;
const alpha = { company_name: 'Fixture Alpha', symbol: 'FALP', market_price: 120, market_change_percent: 1.25, invested_value: 1000, quantity: 10, average_price: 100, current_value: 1200, total_pnl: 200, total_pnl_percent: 20, portfolio_weight_percent: 60, price_vs_average_percent: 20 };
const beta = { ...alpha, company_name: 'Fixture Beta', symbol: 'FBET', market_price: 80, market_change_percent: null, invested_value: 900, current_value: 800, average_price: 90, total_pnl: -100, total_pnl_percent: -11.11, portfolio_weight_percent: 40, price_vs_average_percent: -11.11 };
const snapshot = { id: 4, captured_at: '2026-10-20T14:49:00Z', snapshot_date: '2026-10-20', source: 'manual_paste', parse_status: 'partial', holdings_count: 2, reported_holdings_count: 3, indices_count: 1, wallet_balance: null, current_value: 2000, invested_value: 1900, day_return_value: null, day_return_percent: null, total_return_value: 100, total_return_percent: 5.26, holdings: [alpha, beta], market_indices: [{ name: 'Fixture index', value: 100, change_value: 1, change_percent: 1.01, raw_change_text: 'Synthetic context' }], raw_text: 'Local synthetic portfolio fixture — no live account values', parse_warnings: ['Fixture: totals do not reconcile.'], derived: { parsed_holdings_current_value: 2000, parsed_holdings_invested_value: 1900, parsed_holdings_total_pnl: 100, profitable_holdings_count: 1, loss_making_holdings_count: 1, reconciliation: [{ label: 'Holdings Count', summary_value: 3, parsed_value: 2, delta: -1 }], top_allocations: [alpha, beta], top_gainers: [alpha], top_laggards: [beta] } };
const older = { ...snapshot, id: 3, captured_at: '2026-10-19T10:00:00Z', snapshot_date: '2026-10-19', current_value: 1800, parse_status: 'parsed', parse_warnings: [] };

before(async () => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(temp, 'ts-loader.cjs'), `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;`);
  writeFileSync(join(temp, 'link.jsx'), `import React from 'react'; export default function Link({children,...props}) { return <a {...props}>{children}</a>; }`);
  writeFileSync(join(temp, 'api.js'), `
export class APIError extends Error {}
const fixture = () => window.fixture;
export const apiService = {
  async indmoneyUsPortfolioOverview() {
    const f = fixture(); f.reads++;
    if (f.delay) await new Promise(resolve => setTimeout(resolve, f.delay));
    if (f.failRead) throw new APIError('Fixture read failure');
    return structuredClone(f.overview);
  },
  async indmoneyUsPortfolioSnapshot(id) {
    const f = fixture(); f.detailReads.push(id);
    if (f.failDetail) throw new APIError('Fixture detail failure');
    return structuredClone(f.snapshots.find(item => item.id === id));
  },
  async indmoneyUsCreatePortfolioSnapshot(payload) {
    const f = fixture(); f.saves.push(payload);
    if (f.failSave) throw new APIError('Fixture save failure');
    const saved = { ...f.snapshots[0], id: 5, captured_at: payload.captured_at, snapshot_date: payload.captured_at.slice(0,10), raw_text: payload.raw_text };
    f.overview = { latest: saved, history: [...f.overview.history, saved] }; f.snapshots.push(saved);
    return structuredClone(saved);
  }
};`);
  writeFileSync(join(temp, 'entry.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import Page from ${JSON.stringify(join(frontend, 'app/console/indmoney-us/page.tsx'))}; window.fixture = {...window.fixtureConfig, reads:0, detailReads:[], saves:[]}; const root = createRoot(document.getElementById('app')); root.render(<Page/>);`);
  const compiler = webpack({
    mode: 'development', devtool: false, context: frontend, entry: join(temp, 'entry.tsx'),
    output: { path: temp, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'], modules: [join(frontend, 'node_modules'), 'node_modules'], alias: { '@/services/api$': join(temp, 'api.js'), 'next/link$': join(temp, 'link.jsx'), '@': frontend } },
    module: { rules: [{ test: /\.(tsx?|jsx)$/, exclude: /node_modules/, use: join(temp, 'ts-loader.cjs') }] },
    plugins: [new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
    optimization: { minimize: false },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  css = (await postcss([tailwind()]).process('@import "tailwindcss";', { from: join(frontend, 'app/globals.css') })).css;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

async function openFixture(overrides = {}, width = 1180) {
  const page = await browser.newPage({ viewport: { width, height: 757 }, timezoneId: 'UTC' });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const config = { overview: { latest: snapshot, history: [older, snapshot] }, snapshots: [snapshot, older], ...overrides };
  await page.addInitScript(value => { window.fixtureConfig = value; }, config);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://us-snapshot-fixture.test') return route.abort();
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(temp, 'bundle.js'), 'utf8') });
    if (url.pathname === '/console/indmoney-us') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<meta charset="utf-8"><style>${css}</style><main style="padding:24px;max-width:1800px;margin:auto"><div id="app"></div></main><script src="/bundle.js"></script>` });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Local fixture stage destination</h1>' });
  });
  await page.goto('http://us-snapshot-fixture.test/console/indmoney-us');
  await page.getByRole('heading', { name: 'INDmoney US snapshot' }).waitFor();
  return { page, errors };
}
async function screenshot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page-level overflow');
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  if (/saved-partial|paste-empty|navigation/.test(name)) await page.screenshot({ path: join(evidence, `${name}-viewport.png`) });
  const readback = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    selectedView: document.querySelector('[role=tab][aria-selected=true]')?.textContent,
    visibleText: document.querySelector('main')?.innerText,
    capturedAt: document.querySelector('header time')?.getAttribute('datetime'),
    inputs: Array.from(document.querySelectorAll('input,textarea')).map(el => ({ id: el.id, value: el.value })),
    links: Array.from(document.querySelectorAll('nav a')).map(el => ({ name: el.getAttribute('aria-label') || el.textContent, href: el.getAttribute('href') })),
  }));
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(readback, null, 2));
}
async function waitLoaded(page) {
  await page.getByText('Parse status:', { exact: false }).waitFor();
}

test('actual hydrated page preserves data and all three views at desktop and narrow widths', async () => {
  for (const width of [1180, 390]) {
    const { page, errors } = await openFixture({}, width);
    try {
      await waitLoaded(page);
      assert.equal(await page.getByRole('tab', { name: 'Saved US snapshot' }).getAttribute('aria-selected'), 'true');
      assert.match(await page.locator('header').innerText(), /Manual snapshot[\s\S]*20 Oct 2026[\s\S]*partial/i);
      assert.match(await page.locator('#us-snapshot-panel-saved').innerText(), /\$2,000.00/);
      const holdings = page.locator('#us-snapshot-panel-saved table').first();
      assert.equal(await holdings.locator('th').count(), 10);
      assert.match(await holdings.innerText(), /Fixture Alpha[\s\S]*Fixture Beta/);
      for (const name of ['Top Allocation', 'Top Gainers', 'Laggards', 'Reconciliation', 'Market Indices', 'Raw Pasted Snapshot']) assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 1);
      await screenshot(page, `${width}-saved-partial`);
      await page.getByText('Source details', { exact: true }).click();
      assert.match(await page.locator('details').filter({ has: page.getByText('Source details', { exact: true }) }).innerText(), /no direct API[\s\S]*manual paste/i);
      await screenshot(page, `${width}-source-details`);
      await page.getByText('Source details', { exact: true }).click();
      const reads = await page.evaluate(() => window.fixture.reads);
      await page.getByRole('button', { name: 'Import snapshot', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: 'Paste snapshot', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByRole('button', { name: 'Save Snapshot', exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel('Snapshot timestamp').inputValue() !== '', true);
      await screenshot(page, `${width}-paste-empty`);
      await page.getByLabel('Snapshot timestamp').fill('2026-10-21T09:30');
      await page.getByLabel('Paste INDmoney data here').fill('Local draft holdings');
      assert.equal(await page.getByText('20 chars', { exact: true }).count(), 1);
      for (let n = 0; n < 3; n++) {
        await page.getByRole('tab', { name: 'Saved US snapshot' }).click();
        await page.getByRole('tab', { name: 'Paste snapshot', exact: true }).click();
      }
      assert.equal(await page.getByLabel('Paste INDmoney data here').inputValue(), 'Local draft holdings');
      assert.equal(await page.getByLabel('Snapshot timestamp').inputValue(), '2026-10-21T09:30');
      assert.equal(await page.getByRole('button', { name: 'Save Snapshot', exact: true }).isEnabled(), true);
      await screenshot(page, `${width}-paste-draft`);
      await page.getByRole('tab', { name: 'Market and stage navigation' }).click();
      const navigation = page.getByRole('navigation', { name: 'Portfolio market and stage destinations' });
      assert.equal(await navigation.getByRole('link').count(), 18);
      const routes = ['/console/zerodha', '/console/indmoney-us'];
      for (const [name, suffix] of [['Portfolio', ''], ['Swing Trade', '/swing-trade'], ['Threats', '/threats'], ['Events', '/events'], ['Rebalance', '/rebalance'], ['Final Actionables', '/final-actionables']]) {
        for (const [index, market] of ['India', 'US'].entries()) assert.equal(await navigation.getByRole('link', { name: `${name} — ${market}`, exact: true }).getAttribute('href'), `${routes[index]}${suffix}`);
      }
      assert.equal(await navigation.getByRole('link', { name: 'Portfolio — US', exact: true }).getAttribute('aria-current'), 'page');
      await screenshot(page, `${width}-navigation`);
      await page.getByRole('tab', { name: 'Market and stage navigation' }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Paste snapshot');
      assert.equal(await page.getByRole('tab', { name: 'Paste snapshot', exact: true }).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Saved US snapshot');
      assert.equal(await page.getByRole('tab', { name: 'Saved US snapshot' }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(() => window.fixture.reads), reads, 'view changes must not reload broker or stored records');
      assert.equal(await page.evaluate(() => window.fixture.saves.length), 0, 'view changes must not save');
      await page.getByRole('tab', { name: 'Market and stage navigation' }).click();
      await navigation.getByRole('link', { name: 'Threats — US', exact: true }).click();
      await page.getByRole('heading', { name: 'Local fixture stage destination' }).waitFor();
      await page.goBack();
      await waitLoaded(page);
      assert.equal(await page.getByRole('heading', { name: 'INDmoney US snapshot' }).count(), 1);
      assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('refresh retains historical selection; failure labels stale displayed data without fabricating new values', async () => {
  const { page, errors } = await openFixture();
  try {
    await waitLoaded(page);
    await page.getByRole('button', { name: /View snapshot 19 Oct 2026/ }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fixture.detailReads.includes(3));
    await page.waitForFunction(() => document.querySelector('header time')?.dateTime === '2026-10-19T10:00:00Z');
    await page.getByRole('button', { name: 'Refresh displayed data' }).click();
    await page.waitForFunction(() => window.fixture.detailReads.length >= 2);
    assert.equal(await page.locator('header time').getAttribute('datetime'), older.captured_at);
    await page.evaluate(() => { window.fixture.failRead = true; });
    await page.getByRole('button', { name: 'Refresh displayed data' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Showing previously loaded saved data/);
    assert.equal(await page.locator('header time').getAttribute('datetime'), older.captured_at);
    assert.equal(await page.getByRole('heading', { name: 'Holdings', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
    await screenshot(page, '1180-stale-read-failure');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('loading, confirmed empty, failed and unavailable history remain truthful and recoverable', async () => {
  for (const state of ['loading', 'empty', 'failed', 'unavailable']) {
    const overrides = state === 'loading' ? { delay: 800 } : state === 'empty' ? { overview: { latest: null, history: [] } } : state === 'failed' ? { failRead: true } : { overview: { latest: { ...snapshot, current_value: null }, history: [{ ...snapshot, current_value: null }] } };
    const { page, errors } = await openFixture(overrides);
    try {
      if (state === 'loading') await page.getByText('Loading saved snapshot…').waitFor();
      if (state === 'empty') await page.getByRole('heading', { name: 'No INDmoney snapshots yet' }).waitFor();
      if (state === 'failed') {
        await page.getByRole('alert').waitFor();
        assert.equal(await page.getByRole('heading', { name: 'No INDmoney snapshots yet' }).count(), 0);
        await screenshot(page, '1180-failed');
        await page.evaluate(() => { window.fixture.failRead = false; });
        await page.getByRole('button', { name: 'Refresh displayed data' }).click();
        await waitLoaded(page);
        assert.equal(await page.getByRole('alert').count(), 0);
      }
      if (state === 'unavailable') {
        await waitLoaded(page);
        await page.getByText('No saved current values are available for the trend.').waitFor();
        assert.equal(await page.getByRole('button', { name: /View snapshot/ }).count(), 0);
      }
      await screenshot(page, `1180-${state === 'failed' ? 'recovered' : state}`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('save failure retains draft, explicit fixture save preserves copied timestamp and reports partial status', async () => {
  const { page, errors } = await openFixture({ failSave: true });
  try {
    await waitLoaded(page);
    await page.getByRole('button', { name: 'Import snapshot', exact: true }).click();
    await page.getByLabel('Snapshot timestamp').fill('2026-10-21T09:30');
    await page.getByLabel('Paste INDmoney data here').fill('  Fixture full holdings text  ');
    await page.getByRole('button', { name: 'Save Snapshot', exact: true }).click();
    await page.getByText('Fixture save failure').waitFor();
    assert.equal(await page.getByLabel('Paste INDmoney data here').inputValue(), '  Fixture full holdings text  ');
    await screenshot(page, '1180-save-failure');
    await page.evaluate(() => { window.fixture.failSave = false; });
    await page.getByRole('button', { name: 'Save Snapshot', exact: true }).click();
    await page.getByText('Snapshot saved. Check its parse status and reconciliation warnings in Saved US snapshot.').waitFor();
    assert.equal(await page.getByLabel('Paste INDmoney data here').inputValue(), '');
    const payload = await page.evaluate(() => window.fixture.saves.at(-1));
    assert.equal(payload.raw_text, 'Fixture full holdings text');
    assert.equal(payload.captured_at, '2026-10-21T09:30:00.000Z');
    await page.getByRole('tab', { name: 'Saved US snapshot' }).click();
    assert.match(await page.locator('header').innerText(), /21 Oct 2026[\s\S]*partial/i);
    assert.equal(await page.getByText('Fixture: totals do not reconcile.', { exact: true }).count(), 1);
    assert.match(await page.locator('#us-snapshot-panel-saved pre').innerText(), /Fixture full holdings text/);
    await screenshot(page, '1180-saved-after-fixture-import');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
