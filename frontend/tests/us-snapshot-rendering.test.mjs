import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const cache = new Map();
function load(path, overrides = {}) {
  if (cache.has(path) && !Object.keys(overrides).length) return cache.get(path);
  const source = readFileSync(new URL(path, root), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const result = { exports: {} };
  const stubs = {
    '@/services/api': { apiService: new Proxy({}, { get() { throw new Error('External requests forbidden in fixture'); } }) },
    '@/app/console/dashboard/_components/StageDurationBreakdownDialog': { StageDurationBreakdownDialog: () => null },
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children), __esModule: true },
    ...overrides,
  };
  new Function('require', 'module', 'exports', code)(name => {
    if (name in stubs) return stubs[name];
    if (name.startsWith('@/')) {
      const suffix = ['.ts', '.tsx'].find(ext => { try { readFileSync(new URL(name.slice(2) + ext, root)); return true; } catch { return false; } });
      return load(name.slice(2) + suffix);
    }
    return require(name);
  }, result, result.exports);
  if (!Object.keys(overrides).length) cache.set(path, result.exports);
  return result.exports;
}

const { IndMoneyUsSnapshotsPanel } = load('app/console/indmoney-us/_components/IndMoneyUsSnapshotsPanel.tsx');
const snapshot = { id: 4, captured_at: '2026-10-28T14:49:00Z', snapshot_date: '2026-10-28', source: 'manual_paste', parse_status: 'partial', holdings_count: 0, holdings: [], market_indices: [], raw_text: 'Local synthetic fixture', parse_warnings: ['Fixture: totals do not reconcile.'], derived: { parsed_holdings_current_value: 12, parsed_holdings_invested_value: 10, parsed_holdings_total_pnl: 2, profitable_holdings_count: 0, loss_making_holdings_count: 0, reconciliation: [], top_allocations: [], top_gainers: [], top_laggards: [] } };

test('snapshot panel renders loaded partial, refresh failure, empty and loading without losing provenance', () => {
  const props = { overview: { latest: snapshot, history: [snapshot] }, selectedSnapshot: snapshot, selectedSnapshotId: 4, loading: false, selecting: false, error: null, onSelectSnapshot() {} };
  const html = renderToStaticMarkup(React.createElement(IndMoneyUsSnapshotsPanel, props));
  assert.match(html, /Manual snapshot · saved/);
  assert.match(html, /Parsed does not mean current prices/);
  assert.match(html, /Fixture: totals do not reconcile/);
  assert.match(html, /Historical trend/);
  const stale = renderToStaticMarkup(React.createElement(IndMoneyUsSnapshotsPanel, { ...props, error: 'Refresh failed' }));
  assert.match(stale, /Refresh failed/); assert.match(stale, /Holdings/);
  assert.match(renderToStaticMarkup(React.createElement(IndMoneyUsSnapshotsPanel, { ...props, overview: { history: [] }, selectedSnapshot: null })), /No INDmoney snapshots yet/);
  assert.match(renderToStaticMarkup(React.createElement(IndMoneyUsSnapshotsPanel, { ...props, overview: null, selectedSnapshot: null, loading: true })), /Loading INDmoney/);
  assert.equal(renderToStaticMarkup(React.createElement(IndMoneyUsSnapshotsPanel, { ...props, overview: null, selectedSnapshot: null, error: 'Failed' })), '');
});

test('desktop and narrow snapshot fixtures retain controls, source metadata and visible focus', async () => {
  const css = await postcss([tailwind()]).process('@import "tailwindcss";', { from: new URL('app/globals.css', root).pathname });
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  mkdirSync('/tmp/us-snapshot-evidence', { recursive: true });
  try {
    const page = await browser.newPage();
    for (const width of [1180, 390]) {
      for (const open of [false, true]) {
        let index = 0;
        const Paste = load('app/console/indmoney-us/_components/IndMoneyUsPasteCard.tsx', { react: { ...React, useState: value => [index++ === 3 ? open : typeof value === 'function' ? value() : value, () => {}] } }).IndMoneyUsPasteCard;
        const html = renderToStaticMarkup(React.createElement('div', {}, React.createElement(Paste, { saving: false, error: null, onSubmit() {} }), React.createElement(IndMoneyUsSnapshotsPanel, { overview: { latest: snapshot, history: [snapshot] }, selectedSnapshot: snapshot, selectedSnapshotId: 4, loading: false, selecting: false, error: null, onSelectSnapshot() {} })));
        await page.setViewportSize({ width, height: 757 });
        await page.setContent(`<style>${css.css}</style><main style="padding:24px;max-width:1800px;margin:auto">${html}</main>`);
        assert.equal(await page.locator('button[aria-expanded]').getAttribute('aria-expanded'), String(open));
        if (open) {
          assert.equal(await page.getByRole('button', { name: 'Save Snapshot' }).isDisabled(), true);
          await page.locator('#indmoney-raw-text').fill('Synthetic fixture');
          assert.equal(await page.locator('#indmoney-raw-text').inputValue(), 'Synthetic fixture');
          await page.locator('#indmoney-raw-text').fill('');
        }
        await page.locator('button[aria-expanded]').focus();
        assert.equal(await page.locator('button[aria-expanded]').evaluate(el => el === document.activeElement), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(el => !el.closest('svg') && el.getBoundingClientRect().right > innerWidth).slice(0,30).map(el => [el.tagName, el.className, el.getBoundingClientRect().width]))));
        await page.screenshot({ path: `/tmp/us-snapshot-evidence/${width}-${open ? 'import' : 'saved'}.png`, fullPage: true });
      }
    }
  } finally { await browser.close(); }
});
