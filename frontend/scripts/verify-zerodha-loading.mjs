/** Offline rendering of the production component and stylesheet; no APIs or orders. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'components/ZerodhaBasketLoading.tsx'), 'utf8');
const workflow = await readFile(path.join(root, 'app/console/dashboard/_components/RebalanceWorkflowSections.tsx'), 'utf8');
assert.match(workflow, /loading \? \(isZerodhaPreview \? <ZerodhaBasketLoading \/> : \(/);
assert.match(workflow, /<Loader2 className="size-4 animate-spin" \/> \{loadingLabel\}/);
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exports = {};
new Function('require', 'exports', output)(require, exports);
const markup = renderToStaticMarkup(React.createElement(exports.ZerodhaBasketLoading));
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'app/globals.css'), 'utf8'), { from: path.join(root, 'app/globals.css') });
// Keep surrounding modal chrome representative; mount the actual loading body unchanged.
const html = `<!doctype html><html class="font-sans"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style><body><main class="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-4"><section class="w-full max-w-7xl rounded-3xl bg-white"><header class="border-b border-slate-200 p-5">Zerodha India Place Order Basket</header><div class="overflow-auto p-5">${markup}</div><footer class="border-t border-slate-200 p-5"><button class="bg-blue-600 text-white">Place Order</button></footer></section></main></body></html>`;
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium' });
const directory = process.env.LOADING_SCREENSHOT_DIR || '/tmp/zerodha-loading-screenshots';
await mkdir(directory, { recursive: true });
try {
  for (const [width, height] of [[1440, 900], [390, 844], [320, 700]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const status = page.getByRole('status');
    assert.equal(await status.innerText(), 'Preparing Zerodha Basket');
    const metrics = await status.evaluate(el => {
      const group = el.firstElementChild, [rail, text, dots] = group.children;
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { rail: rect(rail), text: rect(text), group: rect(group), status: rect(el), dots: [...dots.children].map(d => ({ ...rect(d), opacity: getComputedStyle(d).opacity })), color: getComputedStyle(el).color, button: getComputedStyle(document.querySelector('button')).backgroundColor, weight: getComputedStyle(text).fontWeight, size: getComputedStyle(text).fontSize, overflow: document.documentElement.scrollWidth > innerWidth, animations: el.getAnimations({ subtree: true }).length };
    });
    assert.equal(metrics.color, metrics.button);
    assert.equal(metrics.weight, '400');
    assert.equal(metrics.rail.width, 3);
    assert.equal(metrics.rail.height, 68);
    assert.equal(metrics.text.x - metrics.rail.x, 27.5);
    assert.equal(metrics.text.y - metrics.rail.y, 11);
    assert.deepEqual(metrics.dots.map(d => d.opacity), ['1', '0.55', '0.25']);
    assert.equal(metrics.dots[0].width, 4);
    assert.equal(metrics.dots[1].x - metrics.dots[0].x, 11);
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.animations, 0);
    assert.ok(metrics.group.x >= 0 && metrics.group.x + metrics.group.width <= width);
    assert.ok(Math.abs(metrics.group.x + metrics.group.width / 2 - (metrics.status.x + metrics.status.width / 2)) < 1);
    if (width === 1440) {
      assert.equal(metrics.size, '29px');
      assert.equal(metrics.dots[0].y - metrics.rail.y, 60);
    }
    await page.screenshot({ path: path.join(directory, `${width}.png`) });
    console.log(JSON.stringify({ width, passed: true, metrics }));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
