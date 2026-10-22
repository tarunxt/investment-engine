import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const floors = {
  next: '16.3.8', sharp: '0.35.5', postcss: '8.5.23', nanoid: '3.3.18',
  'baseline-browser-mapping': '2.11.0', 'source-map-js': '1.2.2',
};
function atLeast(actual, minimum) {
  assert.match(actual, /^\d+\.\d+\.\d+$/, 'review prerelease versions separately');
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}
for (const [name, floor] of Object.entries(floors)) {
  test(`audited ${name} versions meet the corrected floor and installed identity`, () => {
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
    assert.ok(entries.length, `${name} must remain inventoried`);
    for (const [path, entry] of entries) {
      assert.ok(atLeast(entry.version, floor), `${path}@${entry.version} precedes ${floor}`);
      const installed = JSON.parse(readFileSync(new URL(`${path}/package.json`, root), 'utf8'));
      assert.equal(installed.version, entry.version, 'installed package differs from canonical lock');
      assert.equal(installed.name, name);
    }
  });
}
test('canonical lock resolves dependencies through the official registry with integrity', () => {
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(entry.resolved, `${path} lacks registry provenance`);
    const resolved = new URL(entry.resolved);
    assert.equal(resolved.protocol, 'https:');
    assert.equal(resolved.hostname, 'registry.npmjs.org');
    assert.equal(resolved.username, '');
    assert.equal(resolved.password, '');
    assert.equal(resolved.search, '');
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  }
});
test('upgraded sharp performs a synthetic native image roundtrip', async () => {
  const require = createRequire(import.meta.url);
  const sharp = require('sharp');
  const image = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  assert.equal(metadata.format, 'png');
});
