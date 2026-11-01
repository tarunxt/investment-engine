import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../app/console/apis/page.tsx', import.meta.url), 'utf8');

test('usage failures override cached empty responses and label retained populated responses', () => {
  const body = page.slice(page.indexOf('export default function ApisPage'));
  const failure = body.indexOf(') : error && !data?.items.length ? (');
  const loaded = body.indexOf(') : data && data.items.length > 0 ? (');
  const empty = body.indexOf('No API usage data yet.');
  assert.ok(failure >= 0 && failure < loaded && loaded < empty);
  assert.match(body, /Showing previously loaded summary/);
});

test('usage failure explicitly disclaims zero usage and exposes recovery', () => {
  assert.match(page, /role="alert"[^>]*>\{error\} Usage for the selected period is unverified; this is not a zero-usage result\. Use Refresh to retry\./);
  assert.match(page, /API usage is unavailable\. Use Refresh to retry\./);
});
