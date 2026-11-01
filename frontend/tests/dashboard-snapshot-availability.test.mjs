import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../app/console/dashboard/_components/TotalDataStatus.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'module', 'require', output)(loaded.exports, loaded, require);
const { snapshotAvailability, SnapshotAvailability } = loaded.exports;
const { renderToStaticMarkup } = require('react-dom/server');
const base = { source: 'Zerodha', complete: false, snapshotKnown: false };
for (const [name, info, expected] of [
  ['loading remains unknown', { pending: true }, 'Checking saved snapshot availability'],
  ['failed read makes no absence claim', { failed: true }, 'Cannot verify saved snapshot availability'],
  ['successful empty read confirms only its response', {}, 'No saved snapshot returned by the latest successful read'],
  ['known snapshot without timestamp remains known', { snapshotKnown: true }, 'Saved snapshot available'],
  ['failed read retains known snapshot', { failed: true, snapshotKnown: true }, 'Cannot verify saved snapshot availability · Last-known snapshot shown'],
  ['pending read retains known snapshot', { pending: true, snapshotKnown: true }, 'Checking saved snapshot availability · Last-known snapshot shown'],
  ['cached snapshot is explicitly unverified', { snapshotKnown: true, cachedAt: 123 }, 'Last-known saved snapshot · Current availability unverified'],
]) test(name, () => assert.equal(snapshotAvailability({ ...base, ...info }), expected));
test('status announces labels and links to read-only history without an action handler', () => {
  const html = renderToStaticMarkup(SnapshotAvailability({ info: { ...base, failed: true, historyHref: '/console/zerodha#saved-portfolio-snapshots', historyLabel: 'View India saved portfolio history' } }));
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /href="\/console\/zerodha#saved-portfolio-snapshots"/);
  assert.doesNotMatch(html, /No snapshot available|No stored snapshot|onclick|<button/);
});
