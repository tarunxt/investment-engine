/** Actual Preferences form and settings shell; local API fixture, no live requests. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.PREFS_PAGE_SOURCE || path.join(frontend, 'app/console/profile/preferences/page.tsx');
const baseline = Boolean(process.env.PREFS_PAGE_SOURCE);
const evidence = process.env.PREFS_EVIDENCE_DIR;
const temporary = await mkdtemp(path.join(tmpdir(), 'preferences-scope-'));
let browser, server;
try {
  if (evidence) await mkdir(evidence, { recursive: true });
  await writeFile(path.join(temporary, 'api.ts'), `export const apiService={
    getProfile:()=>new Promise((resolve,reject)=>{window.profileRead={resolve,reject}}),
    updateProfile:(payload)=>{window.saves.push(payload);return new Promise((resolve,reject)=>{window.profileSave={resolve,reject}})}
  };`);
  await writeFile(path.join(temporary, 'navigation.ts'), `export const usePathname=()=>window.location.pathname;`);
  await writeFile(path.join(temporary, 'entry.tsx'), `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import Preferences from ${JSON.stringify(source)};
    import SettingsLayout from ${JSON.stringify(path.join(frontend, 'app/console/profile/layout.tsx'))};
    window.saves=[];
    const mails=location.pathname==='/console/mails';
    createRoot(document.getElementById('root')).render(mails
      ? <h2 id="mail-preferences-heading">Email notification settings destination fixture</h2>
      : <SettingsLayout><Preferences/></SettingsLayout>);
  `);
  await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve, reject) => w.webpack({
    mode: 'development', devtool: false, entry: path.join(temporary, 'entry.tsx'),
    output: { path: temporary, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(frontend, 'node_modules')], alias: {
      '@/services/api': path.join(temporary, 'api.ts'), 'next/navigation': path.join(temporary, 'navigation.ts'), '@': frontend,
    } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(temporary, 'loader.cjs') }] },
    plugins: [new w.webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
  }, (error, stats) => error ? reject(error) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const postcss = require('postcss');
  const cssPath = path.join(frontend, 'app/globals.css');
  const css = (await postcss([require('@tailwindcss/postcss')()]).process(await readFile(cssPath, 'utf8'), { from: cssPath })).css;
  const bundle = await readFile(path.join(temporary, 'bundle.js'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundle : req.url === '/style.css' ? css : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Preferences fixture</title><link rel="stylesheet" href="/style.css"><main style="padding:24px"><div id="root"></div></main><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 757 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const open = async () => {
    await page.goto(`${origin}/console/profile/preferences`);
    await page.waitForFunction(() => Boolean(window.profileRead));
  };
  const profile = { timezone: 'UTC', notification_preferences: 'all', theme_preference: 'light' };
  const loaded = async (value = profile) => {
    await page.evaluate(value => window.profileRead.resolve(value), value);
    await page.waitForFunction(value => document.querySelector('#timezone').value === (value.timezone || 'UTC'), value);
  };
  const save = page.getByRole('button', { name: 'Update preferences', exact: true });
  await open();
  assert.equal(await page.locator('select').count(), 3);
  const optionInventory = {
    theme_preference: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']],
    timezone: [['UTC', 'UTC'], ['America/New_York', 'Eastern Time (US & Canada)'], ['America/Chicago', 'Central Time (US & Canada)'], ['America/Denver', 'Mountain Time (US & Canada)'], ['America/Los_Angeles', 'Pacific Time (US & Canada)'], ['Europe/London', 'London'], ['Europe/Paris', 'Paris'], ['Asia/Tokyo', 'Tokyo'], ['Asia/Calcutta', 'India Standard Time']],
    notification_preferences: [['all', 'All notifications'], ['important', 'Important only'], ['none', 'None']],
  };
  for (const [id, options] of Object.entries(optionInventory)) {
    assert.deepEqual(await page.locator(`#${id} option`).evaluateAll(items => items.map(o => [o.value, o.textContent])), options);
  }
  assert.equal(await page.evaluate(() => window.saves.length), 0); // Opening/loading never saves.
  await loaded();
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'light');
  assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'UTC');
  assert.equal(await page.getByLabel('Notifications', { exact: true }).inputValue(), 'all');
  const destinations = ['/console/profile', '/console/profile/preferences', '/console/profile/cost-drivers', '/console/profile/security', '/console/profile/activity'];
  assert.deepEqual(await page.locator('nav a').evaluateAll(links => links.map(a => a.getAttribute('href'))), destinations);
  assert.equal(await save.count(), 1);
  if (!baseline) {
    assert.equal(await page.locator('#timezone-help').textContent(), 'Example: 12:00 UTC on 1 Jan 2026 is 12:00 in UTC.');
    // Explicit winter examples make DST-dependent zones unambiguous; every native option is retained.
    const times = ['12:00', '07:00', '06:00', '05:00', '04:00', '12:00', '13:00', '21:00', '17:30'];
    for (const [index, [timezone]] of optionInventory.timezone.entries()) {
      await page.getByLabel('Timezone', { exact: true }).selectOption(timezone);
      assert.equal(await page.locator('#timezone-help').textContent(), `Example: 12:00 UTC on 1 Jan 2026 is ${times[index]} in ${timezone}.`);
      assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), timezone);
    }
    if (evidence) await page.screenshot({ path: path.join(evidence, 'after-india-1180x757.png') });
    await page.getByLabel('Timezone', { exact: true }).selectOption('UTC');
    await page.getByLabel('Timezone', { exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'America/New_York');
    assert.match(await page.locator('#timezone-help').textContent(), /07:00 in America\/New_York/);
    if (evidence) await page.screenshot({ path: path.join(evidence, 'after-new-york-1180x757.png') });
    await page.keyboard.press('Home');
    assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'UTC');
    assert.equal(await page.evaluate(() => window.saves.length), 0);
    for (const [id, help] of [['theme_preference', 'theme-help'], ['timezone', 'timezone-help'], ['notification_preferences', 'notifications-help']]) {
      assert.equal(await page.locator(`#${id}`).getAttribute('aria-describedby'), help);
    }
    const categories = page.getByRole('link', { name: 'Email categories', exact: true });
    assert.equal(await categories.getAttribute('href'), '/console/mails#mail-preferences-heading');
    assert.match(await readFile(path.join(frontend, 'app/console/mails/page.tsx'), 'utf8'), /id="mail-preferences-heading"/);
    // Native keyboard focus reaches the new link and the single save action.
    await page.getByLabel('Notifications', { exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await categories.evaluate(el => el === document.activeElement), true);
    assert.equal(await categories.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    assert.notEqual(await categories.evaluate(el => getComputedStyle(el).boxShadow), 'none');
    await page.keyboard.press('Tab');
    assert.equal(await save.evaluate(el => el === document.activeElement), true);
  }
  await save.blur();
  if (evidence) await page.screenshot({ path: path.join(evidence, `${baseline ? 'before' : 'after'}-1180x757.png`) });
  const formWidth = await page.locator('form').evaluate(el => el.getBoundingClientRect().width);
  if (!baseline) assert.ok(formWidth <= 672, `bounded form width ${formWidth}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const formBounds = await page.locator('form').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  assert.ok(formBounds.left >= 0 && formBounds.right <= 375, JSON.stringify(formBounds));
  const shellOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (evidence) await page.screenshot({ path: path.join(evidence, `${baseline ? 'before' : 'after'}-375x812.png`), fullPage: true });
  if (!baseline) {
    await page.setViewportSize({ width: 1180, height: 757 });
    // Mock save verifies unchanged contract, pending/duplicate-click protection and failure recovery.
    await page.getByLabel('Timezone', { exact: true }).selectOption('Asia/Calcutta');
    await page.getByLabel('Notifications', { exact: true }).selectOption('important');
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
    assert.equal(await page.evaluate(() => window.saves.length), 0);
    await save.click();
    const saving = page.getByRole('button', { name: 'Saving...', exact: true });
    assert.equal(await saving.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.saves), [{ timezone: 'Asia/Calcutta', notification_preferences: 'important', theme_preference: 'dark' }]);
    await page.evaluate(() => window.profileSave.reject(new Error('Fixture save failed')));
    await page.getByRole('alert').getByText('Fixture save failed').waitFor();
    assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'Asia/Calcutta');
    await save.click();
    await page.evaluate(() => window.profileSave.reject(new Error('Fixture validation: invalid preference')));
    await page.getByRole('alert').getByText('Fixture validation: invalid preference').waitFor();
    assert.equal(await page.getByLabel('Notifications', { exact: true }).inputValue(), 'important');
    await save.click();
    await page.evaluate(() => window.profileSave.resolve({}));
    await page.getByText('Preferences Updated', { exact: true }).waitFor();
    await page.getByRole('button', { name: '✕', exact: true }).click();
    assert.equal(await page.getByText('Preferences Updated', { exact: true }).count(), 0);
    // New navigation and back use only a placeholder destination, never the live Mails page.
    await page.getByRole('link', { name: 'Email categories', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(`${origin}/console/mails#mail-preferences-heading`);
    await page.getByRole('heading', { name: 'Email notification settings destination fixture' }).waitFor();
    await page.goBack();
    await page.waitForFunction(() => Boolean(window.profileRead));
    await loaded();
    await open();
    await loaded({ timezone: 'America/New_York', notification_preferences: 'none', theme_preference: 'system' });
    assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'America/New_York');
    assert.equal(await page.getByLabel('Notifications', { exact: true }).inputValue(), 'none');
    assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'system');
    assert.match(await page.locator('#timezone-help').textContent(), /07:00 in America\/New_York/);
    assert.equal(await page.evaluate(() => window.saves.length), 0);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(await page.locator('#timezone-help').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    if (evidence) await page.screenshot({ path: path.join(evidence, 'after-new-york-375x812.png'), fullPage: true });
    // Malformed stored zones cannot crash presentation or silently normalize the saved value.
    await open();
    await page.evaluate(() => window.profileRead.resolve({ timezone: 'Invalid/Timezone', notification_preferences: 'all', theme_preference: 'light' }));
    await page.getByText('Time example unavailable for this timezone.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.saves.length), 0);
    // Empty/partial and failed reads retain the existing fallback behavior, no implicit write.
    for (const state of ['empty', 'partial', 'failed']) {
      await open();
      await page.evaluate(state => state === 'failed' ? window.profileRead.reject(new Error('Fixture read failed')) : window.profileRead.resolve(state === 'empty' ? {} : { timezone: 'UTC', theme_preference: 'light' }), state);
      await page.waitForTimeout(50);
      assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'UTC');
      assert.equal(await page.getByLabel('Notifications', { exact: true }).inputValue(), 'all');
      assert.equal(await page.evaluate(() => window.saves.length), 0);
    }
  }
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ baseline, viewport: '1180x757 @ DPR1 / scale1', formWidth, narrowFormBounds: formBounds, existingNarrowShellOverflow: shellOverflow, externalRequests: external.length, result: 'PASS' }));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
