import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

// Actual component render and lifecycle; all remote requests abort before dispatch.
test('A9-R17 hostile markup stays inert and citations/warnings survive rendering', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bundle = await build({
    stdin: { contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import MarkdownRenderer from './components/shared/MarkdownRenderer';
      const root = createRoot(document.getElementById('root'));
      window.renderFixture = content => root.render(<MarkdownRenderer content={content}/>);
      window.unmountFixture = () => root.unmount();`,
      loader: 'tsx', resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    tsconfig: `${root}/tsconfig.json`,
  });
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {})});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    const outbound = [];
    await context.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content: bundle.outputFiles[0].text});
    assert.deepEqual(errors, []);
    const hostile = `<script>window.fixtureExecuted=true</script>\n\n<img src=x onerror="window.fixtureExecuted=true">\n\n[Unsafe](javascript:window.fixtureExecuted=true)\n\n[Source](https://example.invalid/evidence)\n\nWarning: unknown price. Analyst disagreement retained.\n\n| Unknown parameter |\n| --- |\n| <svg onload="window.fixtureExecuted=true"> |`;
    await page.evaluate(value => window.renderFixture(value), hostile);
    await page.locator('article').waitFor();
    assert.equal(await page.locator('article script, article svg, article img[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined);
    const unsafe = page.getByRole('link', {name:'Unsafe', exact:true});
    assert.ok(!(await unsafe.getAttribute('href'))?.startsWith('javascript:'));
    const source = page.getByRole('link', {name:'Source', exact:true});
    assert.equal(await source.getAttribute('href'), 'https://example.invalid/evidence');
    assert.equal(await source.getAttribute('target'), '_blank');
    assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
    assert.match(await page.locator('article').innerText(), /Warning: unknown price\. Analyst disagreement retained/);
    assert.equal(await page.getByTitle('Unknown Stock Parameter header').count(), 1);
    assert.match(await page.locator('article').innerText(), /<script>/);
    await page.evaluate(() => window.renderFixture('Original replacement text: unknown units; do not trade.'));
    await page.getByText('Original replacement text: unknown units; do not trade.', {exact:true}).waitFor();
    await page.evaluate(() => window.unmountFixture());
    assert.equal(await page.locator('article').count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined);
    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
  } finally { await browser.close(); }
});
