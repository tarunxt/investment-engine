// A6-19: actual UniversalScanAutoRunCard, synthetic GETs only; no runtime access.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const require = createRequire(import.meta.url);
const { build } = require(process.env.UNIVERSAL_ESBUILD_PATH || '/tmp/credx-build/node_modules/esbuild');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.UNIVERSAL_EVIDENCE_DIR || '/tmp/audit6-a6-19-browser';
await mkdir(out, { recursive: true });
const sourcePath = path.join(root, 'app/console/trading-bots/_components/UniversalScanAutoRunCard.tsx');
const source = await readFile(sourcePath, 'utf8');
const bundled = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{UniversalScanAutoRunCard}from${JSON.stringify(sourcePath)};createRoot(document.getElementById('root')).render(<><h1 className="text-xl font-bold">Synthetic Universal history acceptance</h1><UniversalScanAutoRunCard/></>);`,
    resolveDir: root, sourcefile: 'a6-19-fixture.tsx', loader: 'tsx',
  },
  bundle: true, write: false, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const css = await postcss([tailwind({ base: root })]).process(
  await readFile(path.join(root, 'app/globals.css'), 'utf8'),
  { from: path.join(root, 'app/globals.css') },
);
const server = createServer((req, res) => {
  const resource = req.url?.split('?')[0];
  if (resource === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(bundled.outputFiles[0].text);
  } else if (resource === '/fixture.css') {
    res.setHeader('Content-Type', 'text/css'); res.end(css.css);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body class="bg-slate-50 text-slate-900"><main id="root" class="mx-auto max-w-5xl p-4"></main><script src="/fixture.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const statusPath = '/api/universal-polymarket-scan/auto-run';
const empty = {
  enabled: false, running: false, paused: false, kill_requested: false, run_id: null,
  start_at: '2026-10-04T10:00:00Z', refresh_minutes: 360, next_run_at: null,
  last_run_at: null, last_completed_at: null, last_completed_run_started_at: null,
  last_total_events: null, last_failed_at: null, last_error: null,
  progress_events: 0, progress_pages: 0, estimated_total_events: null, progress_message: null,
  history: [],
};
const populated = {
  ...empty, last_run_at: '2026-10-04T10:00:00Z', last_completed_at: '2026-10-04T10:01:00Z',
  last_completed_run_started_at: '2026-10-04T10:00:00Z', last_total_events: 17,
  history: [{ id: 'synthetic-saved-run', status: 'completed', triggered_by: 'scheduler',
    started_at: '2026-10-04T10:00:00Z', completed_at: '2026-10-04T10:01:00Z', total_events: 17, error: null }],
};
const results = [], writes = [], external = [], pageErrors = [];
const limitations = new Set();

async function keyboardOpenHistory(page) {
  const trigger = page.getByRole('button', { name: 'History', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Universal Scan auto-run history', exact: true });
  await dialog.waitFor();
  return { trigger, dialog };
}

try {
  for (const width of [1180, 390]) {
    for (const fixture of ['loading', 'failed', 'incomplete', 'empty', 'populated', 'cached-empty', 'cached-populated']) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 1 });
      const reads = [];
      let refreshFailed = false;
      const cached = fixture.startsWith('cached-');
      const payload = fixture.includes('populated') ? populated : empty;
      page.on('pageerror', error => pageErrors.push({ fixture, width, message: error.message }));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') {
          writes.push({ fixture, width, method: request.method(), path: url.pathname });
          await route.abort(); return;
        }
        if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
        if (url.pathname === statusPath) {
          reads.push({ method: request.method(), path: url.pathname });
          if (fixture === 'loading') return; // Deliberately pending; page close cancels fixture GET.
          if (fixture === 'failed' || refreshFailed) {
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic saved-status source unavailable' }) });
          } else {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture === 'incomplete' ? { history: [] } : payload) });
          }
          return;
        }
        assert.ok(['/', '/fixture.js', '/fixture.css', '/favicon.ico'].includes(url.pathname), `Unexpected fixture read: ${url.pathname}`);
        await route.continue();
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Synthetic Universal history acceptance' }).waitFor();
      if (fixture === 'loading') {
        await page.getByText('Loading failed-run status…', { exact: true }).waitFor();
      } else if (fixture === 'failed' || fixture === 'incomplete') {
        await page.getByText('Failed-run status unavailable.', { exact: true }).waitFor();
        if (fixture === 'incomplete') await page.getByRole('button', { name: /status response is incomplete/ }).waitFor();
      } else {
        await page.getByText('No failed Universal Scan auto-run.', { exact: true }).waitFor();
      }
      if (cached) {
        refreshFailed = true;
        await page.getByRole('button', { name: 'Refresh auto-run status', exact: true }).click();
        await page.getByText(/Showing the last successful auto-run status from/).waitFor();
      }
      const { trigger, dialog } = await keyboardOpenHistory(page);
      const readsOnOpen = reads.length;
      if (fixture === 'loading') {
        await dialog.getByText('Loading Universal Scan auto-run history…', { exact: true }).waitFor();
      } else if (fixture === 'failed' || fixture === 'incomplete') {
        await dialog.getByText('Universal Scan auto-run history unavailable. Refresh status to retry.', { exact: true }).waitFor();
      } else if (fixture.includes('populated')) {
        await dialog.getByText(/17 events/).waitFor();
        await dialog.getByText('completed', { exact: true }).waitFor();
        assert.doesNotMatch(await dialog.innerText(), /No Universal Scan auto-runs yet/);
      } else {
        await dialog.getByText('No Universal Scan auto-runs yet.', { exact: true }).waitFor();
      }
      if (cached) await dialog.getByText(/Could not refresh auto-run history. Showing the last successful status from/).waitFor();
      if (['loading', 'failed', 'incomplete'].includes(fixture)) {
        assert.doesNotMatch(await page.locator('body').innerText(), /No Universal Scan auto-runs yet|No failed Universal Scan auto-run/);
      }
      const bounds = await dialog.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'History dialog fits viewport');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document overflow');
      assert.equal(reads.length, readsOnOpen, 'Opening history does not request or run anything');
      const initialFocusInside = await dialog.evaluate(element => element.contains(document.activeElement));
      if (!initialFocusInside) limitations.add('Existing history dialog does not move keyboard focus inside on open.');
      await page.keyboard.press('Escape');
      const escapeClosed = await dialog.count() === 0;
      if (!escapeClosed) limitations.add('Existing history dialog does not close on Escape; its named Close history button remains available.');
      if (escapeClosed) await trigger.click();
      const close = page.getByRole('button', { name: 'Close history', exact: true });
      await close.focus();
      assert.equal(await close.evaluate(element => document.activeElement === element), true);
      await page.screenshot({ path: path.join(out, `${fixture}-${width}.png`), fullPage: true });
      await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(reads.length, readsOnOpen, 'Safe keyboard close makes no extra request');
      const focusReturned = await trigger.evaluate(element => document.activeElement === element);
      if (!focusReturned) limitations.add('Existing history dialog does not restore focus to its trigger after close.');
      results.push({ fixture, width, reads: reads.length, historyState: fixture, initialFocusInside, escapeClosed, focusReturned, keyboardOpenAndNamedClose: true });
      await page.close();
    }
  }
  assert.deepEqual(writes, [], 'No mutation or execution requests');
  assert.deepEqual(external, [], 'No external/provider/runtime requests');
  assert.deepEqual(pageErrors, [], 'No browser exceptions');
  const result = { timestamp: new Date().toISOString(), sourceSha256: createHash('sha256').update(source).digest('hex'), component: 'UniversalScanAutoRunCard', fixtures: results, writes, external, pageErrors, limitations: [...limitations] };
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`PASS ${results.length} actual-component source-state fixtures; desktop/390px; keyboard open/close; no write/external requests. Existing dialog accessibility limitations are recorded separately.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
