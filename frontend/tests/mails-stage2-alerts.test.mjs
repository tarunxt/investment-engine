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

test('delivery audit renders the complete Sell action lifecycle and write-back controls', () => {
  assert.match(source, /'detected'/);
  assert.match(source, /'awaiting_confirmation'/);
  assert.match(source, /'confirmed'/);
  assert.match(source, /'submitting'/);
  assert.match(source, /'filled'/);
  assert.match(source, /'pending'/);
  assert.match(source, /'failed'/);
  assert.match(source, /'cleared'/);
  assert.match(source, /Sell action taken/);
  assert.match(source, /URLs\.mails\.sellAction\(item\.id\)/);
  assert.match(source, /Bullpen transaction link/);
});


test('Sell batch preparation uses only fresh live Bullpen odds', () => {
  assert.match(source, /Sell Batch Preparation/);
  assert.match(source, /Live held-side Bullpen odds/);
  assert.match(source, /LLM odds are ignored/);
  assert.match(source, /liveOdds < threshold/);
  assert.match(source, /Recovered \/ excluded/);
  assert.match(source, /Average Sell price/);
  assert.match(source, /Expected proceeds/);
  assert.match(source, /Save live details/);
});


test('mails console documents both GPT-enabled Sell workflows', () => {
  assert.match(source, /GPT-enabled Sell Workflows/);
  assert.match(source, /Email-triggered Bullpen Sell/);
  assert.match(source, /Hourly Bullpen Sell Check/);
  assert.match(source, /Once every hour · Asia\/Kolkata/);
  assert.match(source, /Both workflows merge and de-duplicate positions by canonical market ID/);
  assert.match(source, /Approve the latest complete batch in its GPT Work chat on laptop or mobile/);
  assert.match(source, /Cred-X Bullpen History/);
  assert.match(source, /Live Bullpen Predictions wallet/);
});
