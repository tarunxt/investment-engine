import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../app/console/mails/page.tsx', import.meta.url),
  'utf8',
);

test('mail history shows LLM and actual Bullpen odds with the breach source', () => {
  assert.match(source, /held_side_llm_odds\?: number/);
  assert.match(source, /held_side_bullpen_odds\?: number/);
  assert.match(source, /breach_sources\?: string\[\]/);
  assert.match(source, /Actual Bullpen:/);
  assert.match(source, /warning\.breach_sources\?\.join\(' and '\)/);
});
