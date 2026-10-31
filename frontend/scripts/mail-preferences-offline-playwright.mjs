/** Offline acceptance: actual Mails page, mocked reads and mutations, no backend. */
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
const sourceRoot = process.env.MAIL_PREFS_SOURCE_ROOT || frontend;
const temporary = await mkdtemp(path.join(tmpdir(), 'mail-prefs-fixture-'));
let browser, server;
try {
  await writeFile(path.join(temporary, 'entry.tsx'), `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import MailsPage from ${JSON.stringify(path.join(sourceRoot, 'app/console/mails/page.tsx'))};
    window.reads=[]; window.mutations=[];
    window.fetch=(url,options={})=>{
      if(options.method && options.method!=='GET'){
        window.mutations.push({url,options});
        return Promise.resolve(new Response(JSON.stringify({detail:'Mock save failure'}),{status:503}));
      }
      if(String(url).includes('/preferences')) return new Promise((resolve,reject)=>window.reads.push({resolve,reject}));
      return Promise.resolve(new Response(JSON.stringify({items:[],workflow_runs:[]}),{status:200}));
    };
    window.settle=(index,status,items)=>window.reads[index].resolve(new Response(JSON.stringify({items}),{status}));
    // StrictMode creates an obsolete first request: the test settles it last.
    createRoot(document.getElementById('root')).render(<React.StrictMode><MailsPage/></React.StrictMode>);
  `);
  await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve, reject) => w.webpack({
    mode: 'development', devtool: false, entry: path.join(temporary, 'entry.tsx'),
    output: { path: temporary, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(frontend, 'node_modules')], alias: { '@': sourceRoot } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(temporary, 'loader.cjs') }] },
    plugins: [new w.webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
  }, (error, stats) => error ? reject(error) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const bundle = await readFile(path.join(temporary, 'bundle.js'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/bundle.js' ? bundle : '<!doctype html><title>Offline mail preferences fixture</title><style>body{font:14px sans-serif;max-width:1000px;margin:auto}button{padding:8px;margin:4px}svg{width:18px;height:18px}section{padding:12px;border:1px solid #ddd}button:disabled{opacity:.5}</style><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const settings = page.getByRole('region', { name: 'Email notification settings', exact: true });
  const save = settings.getByRole('button', { name: 'Save preferences', exact: true });
  const completion = settings.getByRole('button', { name: /Stage and scan completion/ });
  const settle = (index, status, items) => page.evaluate(args => window.settle(...args), [index, status, items]);
  const fixture = [{ key: 'completion.stage1', label: 'Stage 1', enabled: true, segments: ['Bullpen'], group: 'completion' }, { key: 'risk', label: 'Risk alerts', description: 'Fixture only', enabled: false, segments: ['Bullpen'], group: 'alerts' }];
  await page.goto(origin);
  await page.waitForFunction(() => window.reads.length === 2);
  assert.equal(await save.isDisabled(), true);
  await settings.getByText('Loading notification settings…', { exact: true }).waitFor();
  await settle(1, 503);
  await settings.getByRole('alert').waitFor();
  if (process.env.MAIL_PREFS_EXPECT_BASELINE) {
    assert.match(await completion.textContent(), /0 of 0 notifications selected/);
    assert.equal(await settings.getByRole('button', { name: 'Retry settings' }).count(), 0);
    console.log('Baseline reproduced: failed retrieval displays 0 of 0 and no retry.');
  } else {
    assert.match(await completion.textContent(), /Unavailable/);
    assert.doesNotMatch(await settings.textContent(), /0 of 0 notifications selected/);
    for (const name of ['Select all', 'Deselect all', 'Save preferences']) assert.equal(await settings.getByRole('button', { name, exact: true }).isDisabled(), true);
    assert.equal(await completion.isDisabled(), true);
    const retry = settings.getByRole('button', { name: 'Retry settings', exact: true });
    // Keyboard-operable retry; while loading the button cannot repeat requests.
    await retry.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.reads.length === 3);
    await settings.getByRole('status').getByText('Loading notification settings…', { exact: true }).waitFor();
    assert.equal(await retry.count(), 0);
    await page.evaluate(() => window.reads[2].reject(new TypeError('Network unavailable')));
    await retry.waitFor();
    assert.match(await completion.textContent(), /Unavailable/);
    await retry.click();
    await page.waitForFunction(() => window.reads.length === 4);
    await settle(3, 200, fixture);
    await page.waitForFunction(() => !document.body.textContent.includes('Loading notification settings…'));
    await completion.getByText('1 of 1 notifications selected · Configure stages', { exact: true }).waitFor();
    assert.equal(await save.isDisabled(), true);
    await settings.getByRole('checkbox').check();
    assert.equal(await save.isDisabled(), false);
    // The obsolete StrictMode read cannot overwrite loaded settings or user edits.
    await settle(0, 200, []);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await settings.getByRole('checkbox').isChecked(), true);
    assert.match(await completion.textContent(), /1 of 1/);
    assert.equal(await retry.count(), 0);
    // Mutation is mocked. A save failure preserves edits and must not offer a reload.
    await save.click();
    await settings.getByRole('alert').getByText('Mail preferences could not be saved.').waitFor();
    assert.equal(await settings.getByRole('checkbox').isChecked(), true);
    assert.equal(await save.isDisabled(), false);
    assert.equal(await retry.count(), 0);
    assert.equal(await page.evaluate(() => window.mutations.length), 1);
    assert.match(await settings.textContent(), /Changes apply to future emails only/);
    // A fresh, confirmed empty response retains the genuine empty count.
    await page.reload(); await page.waitForFunction(() => window.reads.length === 2);
    await settle(1, 200, []);
    await completion.getByText('0 of 0 notifications selected · Configure stages').waitFor();
    assert.equal(await retry.count(), 0);
    assert.equal(await save.isDisabled(), true);
    // An older failure cannot turn a newer success into Unavailable.
    await settle(0, 503);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await settings.getByRole('alert').count(), 0);
    assert.match(await completion.textContent(), /0 of 0/);
    await page.reload(); await page.waitForFunction(() => window.reads.length === 2);
    await settle(1, 200, null);
    await retry.waitFor();
    assert.match(await completion.textContent(), /Unavailable/);
    if (process.env.MAIL_PREFS_SCREENSHOT) {
      await mkdir(path.dirname(process.env.MAIL_PREFS_SCREENSHOT), { recursive: true });
      await settings.screenshot({ path: process.env.MAIL_PREFS_SCREENSHOT });
    }
    console.log('PASS loading, HTTP/network/malformed failure, repeated keyboard retry, success, true empty, user edits, mocked save failure, stale success/failure, accessible status/alert/disabled controls.');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
