import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedEnvironment,browserReceipt,REQUIRED_CHECKS} from './stage18-browser-evidence.mjs';
const valid=()=>({sourceSha:'a'.repeat(40),files:[import.meta.filename,...['../package.json','../package-lock.json','./stage18-browser-evidence.mjs','./auth-rendering-playwright.mjs','../tests/fixtures/stage08-ready-manifest.json'].map(f=>new URL(f,import.meta.url).pathname)],checks:REQUIRED_CHECKS.map(name=>({name,passed:true,duration_seconds:1})),load:{duration_seconds:1,configured_concurrency:3,completed:12,errors:0,observed_peak_concurrency:3,p95_seconds:1,threshold_seconds:10}});
test('allowlisted runtime does not inherit provider secrets and retains auth',()=>{process.env.OPENAI_API_KEY='sentinel';const e=isolatedEnvironment('http://127.0.0.1:1234','/usr/bin','/tmp/guard.cjs',1234);assert.equal(e.OPENAI_API_KEY,undefined);assert.equal(e.NEXT_PUBLIC_DISABLE_AUTH,'false');assert.equal(e.ZERODHA_RECOVERY_MANUAL_ORDERS_ENABLED,'false');assert.throws(()=>isolatedEnvironment('https://cred-x.in','x','x',1));});
test('receipt retains acceptance limits',()=>{const r=browserReceipt(valid());for(const flag of ['full_release_verified','real_provider_certification','deployed_uat2_verified','production_capacity_verified'])assert.equal(r[flag],false);});
for(const [name,mutate] of Object.entries({badSha:v=>v.sourceSha='main',failure:v=>v.checks[0].passed=false,missing:v=>v.load.completed=11,errors:v=>v.load.errors=1,unbounded:v=>v.load.observed_peak_concurrency=4,slow:v=>v.load.p95_seconds=11,forgedThreshold:v=>v.load.threshold_seconds=Infinity,invalidPeak:v=>v.load.observed_peak_concurrency=1.5,emptyFiles:v=>v.files=[],missingCheck:v=>v.checks.pop(),badDuration:v=>v.checks[0].duration_seconds=NaN,badLoadDuration:v=>v.load.duration_seconds=-1,wrongCap:v=>v.load.configured_concurrency=100000}))test(`reject ${name}`,()=>{const v=valid();mutate(v);assert.throws(()=>browserReceipt(v));});

import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildContentDigest} from './stage18-browser-evidence.mjs';
test('served build content digest changes when a chunk changes and rejects links',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'stage18-digest-'));
 try {writeFileSync(path.join(root,'chunk.js'),'one');const a=buildContentDigest(root);writeFileSync(path.join(root,'chunk.js'),'two');assert.notEqual(a.sha256,buildContentDigest(root).sha256);symlinkSync('/tmp',path.join(root,'escape'));assert.throws(()=>buildContentDigest(root));}finally{rmSync(root,{recursive:true,force:true});}
});
