import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../lib/technicalPriceEvidence.ts', import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports = {}; new Function('exports',compiled)(exports);
const now = Date.parse('2026-10-29T09:17:00Z');
const quote = {instrument:'NSE:BEL',price:368,as_of:new Date(now).toISOString(),source:'kite'};
test('captures exact venue timestamped broker anchors',()=>assert.match(exports.technicalPriceEvidence(['NSE:BEL'],{quotes:[quote],missing:[]},now), /TECHNICAL_PRICE_ANCHORS_V1/));
// A7-L02: synthetic boundary evidence, never a replay of workflow 212.
for (const age of [-60000, 0, 900000]) test(`accepts documented quote age boundary ${age}ms`, () => {
  const boundary = {...quote, as_of:new Date(now - age).toISOString()};
  const result = {quotes:[boundary],missing:[]};
  const original = structuredClone(result);
  const prompt = exports.technicalPriceEvidence([quote.instrument,quote.instrument],result,now);
  const anchors = JSON.parse(prompt.match(/\[TECHNICAL_PRICE_ANCHORS_V1\]\s*(.*?)\s*\[\/TECHNICAL_PRICE_ANCHORS_V1\]/s)[1]);
  assert.deepEqual(anchors,[boundary]);
  assert.deepEqual(result,original);
});
for (const [label,patch] of [
  ['one millisecond too old',{as_of:new Date(now-900001).toISOString()}],
  ['one millisecond too far ahead',{as_of:new Date(now+60001).toISOString()}],
  ['missing timestamp',{as_of:undefined}], ['invalid timestamp',{as_of:'unknown'}],
  ['zero price',{price:0}], ['negative price',{price:-1}], ['infinite price',{price:Infinity}],
]) test(`fail closed without research downgrade: ${label}`, async () => {
  const result = {quotes:[{...quote,...patch}],missing:[]};
  const original = structuredClone(result);
  await assert.rejects(exports.resolveTechnicalPriceEvidence([quote.instrument],async()=>result,now), /Invalid broker (?:price|quote timestamp)|Future-dated broker quote|Stale broker quote/);
  assert.deepEqual(result,original);
});
test('partial batch remains rejected on repeated attempts and accepts a later valid fixture', async () => {
  const second = {...quote,instrument:'NSE:SYNTHETIC'};
  const partial = {quotes:[quote],missing:[second.instrument]};
  for (let attempt=0;attempt<2;attempt++) {
    await assert.rejects(exports.resolveTechnicalPriceEvidence([quote.instrument,second.instrument],async()=>partial,now), /Missing or ambiguous/);
  }
  const prompt = await exports.resolveTechnicalPriceEvidence([quote.instrument,second.instrument],async()=>({quotes:[quote,second],missing:[]}),now);
  assert.match(prompt,/NSE:SYNTHETIC/);
  assert.deepEqual(partial,{quotes:[quote],missing:[second.instrument]});
});
for (const [label,quotes] of [['wrong venue',[{...quote,instrument:'BSE:BEL'}]],['duplicate',[quote,quote]],['stale',[{...quote,as_of:'2026-10-28T09:17:00Z'}]],['bad price',[{...quote,price:NaN}]]]) test(label,()=>assert.throws(()=>exports.technicalPriceEvidence(['NSE:BEL'],{quotes,missing:[]},now)));

test('Personal API permission denial continues with explicitly unanchored research', async () => {
  const denied = Object.assign(new Error('Zerodha denied market-data access (PermissionException). This connection cannot provide live quotes.'), {status:403});
  let requests = 0;
  const prompt = await exports.resolveTechnicalPriceEvidence(['NSE:BEL'], async keys => {requests++; assert.deepEqual(keys,['NSE:BEL']); throw denied;}, now);
  assert.equal(requests,1);
  assert.match(prompt,/TECHNICAL_PRICE_MODE_V1/);
  assert.match(prompt,/internet_research_no_broker_quotes/);
  assert.doesNotMatch(prompt,/TECHNICAL_PRICE_ANCHORS_V1/);
});
test('paid API retains exact-venue broker price validation', async () => {
  const prompt = await exports.resolveTechnicalPriceEvidence(['NSE:BEL'], async () => ({quotes:[quote],missing:[]}), now);
  assert.match(prompt,/TECHNICAL_PRICE_ANCHORS_V1/);
  assert.doesNotMatch(prompt,/internet_research_no_broker_quotes/);
});
test('unrelated failures and malformed successful quotes do not silently downgrade', async () => {
  for (const error of [new Error('offline'), Object.assign(new Error('TokenException'),{status:409}), Object.assign(new Error('Forbidden'),{status:403}), Object.assign(new Error('Zerodha denied market-data access (PermissionException)'),{status:502})]) {
    await assert.rejects(exports.resolveTechnicalPriceEvidence(['NSE:BEL'],async()=>{throw error;},now),e=>e===error);
  }
  for (const quotes of [[],[{...quote,instrument:'BSE:BEL'}],[{...quote,as_of:'2026-10-28T09:17:00Z'}]]) {
    await assert.rejects(exports.resolveTechnicalPriceEvidence(['NSE:BEL'],async()=>({quotes,missing:[]}),now));
  }
});


test('stale quote error reports exact venue, quote time, age and blocked downstream stage',()=>{
 const stale={...quote,instrument:'BSE:BEL',as_of:new Date(now-900001).toISOString()};
 assert.throws(()=>exports.technicalPriceEvidence(['BSE:BEL'],{quotes:[stale],missing:[]},now),error=>{
   assert.match(error.message,/Stale broker quote for BSE:BEL/);
   assert.ok(error.message.includes(stale.as_of));
   assert.match(error.message,/age 900.001 seconds/);
   assert.match(error.message,/15 minutes/);
   assert.match(error.message,/Technical validation has not started/);
   assert.match(error.message,/cannot produce final actionables/);
   return true;
 });
});
test('default freshness clock is read at response validation, not request start',async()=>{
 const original=Date.now; let clock=now;
 Date.now=()=>clock;
 try {
   const delayed={...quote,as_of:new Date(now-899000).toISOString()};
   await assert.rejects(exports.resolveTechnicalPriceEvidence(['NSE:BEL'],async()=>{clock+=2000;return {quotes:[delayed],missing:[]};}),/Stale broker quote.*age 901.000 seconds/);
   const futureAtStart={...quote,as_of:new Date(now+61000).toISOString()};clock=now;
   const accepted=await exports.resolveTechnicalPriceEvidence(['NSE:BEL'],async()=>{clock+=2000;return {quotes:[futureAtStart],missing:[]};});
   assert.match(accepted,/TECHNICAL_PRICE_ANCHORS_V1/);
 } finally {Date.now=original;}
});
test('malformed response and invalid validation clock fail closed',()=>{
 for(const response of [null,{}, {quotes:null}])assert.throws(()=>exports.technicalPriceEvidence(['NSE:BEL'],response,now),/Malformed broker quote response/);
 assert.throws(()=>exports.technicalPriceEvidence(['NSE:BEL'],{quotes:[quote]},NaN),/validation time is unavailable/);
});
