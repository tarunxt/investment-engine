import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import ts from 'typescript';
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(frontend, '../backend');
const python = process.env.TEST_PYTHON || 'python3';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'canonical-export-'));
  const previous = { ...process.env };
  Object.assign(process.env, {
    BULLPEN_STAGE_ONE_EXPORT_DIRECTORY: join(root, 'exports'), UNIVERSAL_SCAN_ARCHIVE_DIRECTORY: join(root, 'archive'),
    BULLPEN_STORAGE_RESERVATION_DIRECTORY: join(root, 'exports'), BULLPEN_CANONICAL_EXPORT_STORAGE: '1', BULLPEN_STORAGE_RESERVATIONS: '1',
    BULLPEN_STORAGE_BUDGET_PYTHON: python, BULLPEN_STORAGE_BUDGET_HELPER: join(backend, 'scripts/scan-storage-budget.py'), PYTHONPATH: backend,
  });
  const capture = spawnSync(python, ['-c', `
import json
from datetime import UTC,datetime,timedelta
from types import SimpleNamespace
from app.domains.trading_bots.universal_scan import UniversalExportWriter
now=datetime(2026,10,1,tzinfo=UTC)
m=SimpleNamespace(market_id='42',question='Original question',raw={'extra':{'nested':[False,0,'kept']}},close_time=(now+timedelta(days=10)).isoformat(),theme='Politics',current_yes_odds=95,current_no_odds=5,volume_usd=10000,liquidity_usd=10000,volume_24hr_usd=10000,spread_cents=1,slug='original',market_url=None,outcome_labels=['Yes','No'],description='rules')
ids=[]
for _ in range(2):
 with UniversalExportWriter(42,started_at=now) as w:
  w.add(m); w.complete(); ids.append(w.export_id)
print(json.dumps(ids))
`], { encoding: 'utf8', env: process.env });
  assert.equal(capture.status, 0, capture.stderr);
  const ids = JSON.parse(capture.stdout.trim());
  const source = readFileSync(join(frontend, 'app/api/bullpen-ai/_lib/stageOneGammaExport.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
  const modulePath = join(root, 'export-module.mjs');
  writeFileSync(modulePath, outputText);
  const module = await import(pathToFileURL(modulePath).href);
  return { root, ids, module, modulePath, async cleanup() {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); await rm(root, { recursive: true, force: true });
  } };
}
test('exact captures and workflow aliases preserve direct paths, filter isolation, ownership and wallet copy-on-write', async () => {
  const {root, ids, module, cleanup} = await fixture();
  try {
    const primary=join(root,'exports',`${ids[0]}.jsonl`), backup=join(root,'archive',`${ids[0]}.jsonl`);
    assert.equal(statSync(primary).ino,statSync(join(root,'exports',`${ids[1]}.jsonl`)).ino);
    assert.notEqual(statSync(primary).ino,statSync(backup).ino);
    const [a,b]=await Promise.all([module.forkUniversalScan('a',ids[0],'42'),module.forkUniversalScan('b',ids[0],'42')]);
    const alias=join(root,'exports',`${a}.jsonl`);
    assert.equal(statSync(alias).ino,statSync(primary).ino);
    assert.equal(statSync(join(root,'exports',`${b}.jsonl`)).ino,statSync(primary).ino);
    assert.deepEqual(readFileSync(alias),readFileSync(primary));
    assert.equal((await module.readStageOneGammaExport({exportId:a,ownerKey:'a'})).rows[0].market.extra.nested[2],'kept');
    await assert.rejects(module.readStageOneGammaExport({exportId:a,ownerKey:'wrong'}),/does not belong/);
    const filtered=await module.reapplyStageOneGammaExportFilters({exportId:b,ownerKey:'b',filters:{},evaluate:()=>[]});
    assert.equal(filtered.metadata.acceptedCount,1);
    assert.equal(filtered.metadata.sourceScanExportId,ids[0]);
    const wallet={candidate:{id:'wallet',question:'Wallet'},event:{source:'active_wallet_position'},market:{},scanStatus:'passed',filterReasons:[],forceIncludedPosition:true};
    await module.appendStageOneGammaExportPage({exportId:a,ownerKey:'a',pageKey:'wallet',rows:[wallet],completed:true});
    assert.notEqual(statSync(alias).ino,statSync(primary).ino);
    assert.equal((await module.readStageOneGammaExport({exportId:a,ownerKey:'a'})).rows.length,2);
    assert.equal((await module.readStageOneGammaExport({exportId:ids[0],ownerKey:'42:universal'})).rows.length,1);
    assert.deepEqual(JSON.parse(readFileSync(join(root,'exports/.storage-admission/claims.json'))).claims,{});
  } finally {await cleanup();}
});
test('historical downloads recover exact independent bytes and never alias recovery after primary corruption',async()=>{
 const {root,ids,module,cleanup}=await fixture();
 try {
  const a=await module.forkUniversalScan('a',ids[0],'42');
  const primary=join(root,'exports',`${ids[0]}.jsonl`),backup=join(root,'archive',`${ids[0]}.jsonl`);
  writeFileSync(primary,Buffer.alloc(statSync(primary).size,120));
  const opened=await module.openStageOneGammaExport({exportId:a,ownerKey:'a'});
  assert.equal(opened.rowsPath,backup);
  assert.equal(opened.filteredRowsPath,join(root,'exports',`${a}.filtered.jsonl`));
  assert.equal((await module.readStageOneGammaExport({exportId:a,ownerKey:'a'})).rows[0].candidate.question,'Original question');
  const fresh=await module.forkUniversalScan('fresh',ids[0],'42');
  assert.notEqual(statSync(join(root,'exports',`${fresh}.jsonl`)).ino,statSync(backup).ino);
  writeFileSync(backup,'broken');
  await assert.rejects(module.readStageOneGammaExport({exportId:a,ownerKey:'a'}),/recovery payload does not match/);
 } finally {await cleanup();}
});
test('recovery ownership and missing reservation adapter configuration fail closed',async()=>{
 const {root,ids,module,cleanup}=await fixture();
 try {
  const path=join(root,'archive',`${ids[0]}.json`),m=JSON.parse(readFileSync(path));
  m.ownerHash='wrong';writeFileSync(path,JSON.stringify(m));
  await assert.rejects(module.forkUniversalScan('a',ids[0],'42'),/ownership does not match/);
  delete process.env.BULLPEN_STORAGE_BUDGET_HELPER;
  await assert.rejects(module.appendStageOneGammaExportPage({exportId:null,ownerKey:'new',pageKey:'first',rows:[],completed:false}),/explicitly configured/);
 } finally {await cleanup();}
});

function childAppend(modulePath, exportId, identity) {
  return new Promise((resolve, reject) => {
    const code = `import {pathToFileURL} from 'node:url';
const m=await import(pathToFileURL(process.argv[1]).href);
const id=process.argv[3];
const row={candidate:{id,question:id},event:{source:'active_wallet_position'},market:{},scanStatus:'passed',filterReasons:[],forceIncludedPosition:true};
await m.appendStageOneGammaExportPage({exportId:process.argv[2],ownerKey:'a',pageKey:id,rows:[row],completed:true});`;
    const child=spawn(process.execPath,['--input-type=module','-e',code,modulePath,exportId,identity],{env:process.env});
    let errors=''; child.stderr.on('data',x=>errors+=x);
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(errors)));
  });
}
test('independent Node processes append without COW loss, including after sharing flag is disabled',async()=>{
 const {root,ids,module,modulePath,cleanup}=await fixture();
 try {
  const id=await module.forkUniversalScan('a',ids[0],'42');
  process.env.BULLPEN_CANONICAL_EXPORT_STORAGE='0';
  process.env.BULLPEN_STORAGE_RESERVATIONS='0';
  await Promise.all([childAppend(modulePath,id,'wallet-one'),childAppend(modulePath,id,'wallet-two')]);
  const current=await module.readStageOneGammaExport({exportId:id,ownerKey:'a'});
  assert.equal(current.rows.length,3);
  assert.equal(current.metadata.rowCount,3);
  assert.deepEqual(current.metadata.processedPages.filter(x=>x.startsWith('wallet')).sort(),['wallet-one','wallet-two']);
  assert.equal(current.metadata.immutableRowsStorage,undefined);
  await childAppend(modulePath,id,'wallet-one'); // restart/page retry is idempotent
  assert.equal((await module.readStageOneGammaExport({exportId:id,ownerKey:'a'})).rows.length,3);
  assert.equal((await module.readStageOneGammaExport({exportId:ids[0],ownerKey:'42:universal'})).rows.length,1);
  assert.notEqual(statSync(join(root,'exports',`${id}.jsonl`)).ino,statSync(join(root,'exports',`${ids[0]}.jsonl`)).ino);
  delete process.env.BULLPEN_STORAGE_BUDGET_HELPER;
  await assert.rejects(childAppend(modulePath,id,'blocked-wallet'),/explicitly configured/);
  assert.equal(readFileSync(join(root,'exports',`${id}.jsonl`),'utf8').trim().split('\n').length,3);
 } finally {await cleanup();}
});
test('stale summaries cannot restore immutable routing before or after a successful append',async()=>{
 const {ids,module,cleanup}=await fixture();
 try {
  const id=await module.forkUniversalScan('a',ids[0],'42');
  const stale=(await module.readStageOneGammaExport({exportId:id,ownerKey:'a'})).metadata;
  const wallet={candidate:{id:'wallet',question:'Wallet'},event:{},market:{},scanStatus:'passed',filterReasons:[]};
  await Promise.all([
   module.appendStageOneGammaExportPage({exportId:id,ownerKey:'a',pageKey:'wallet',rows:[wallet],completed:true}),
   module.cacheStageOneGammaExportSummary({metadata:stale,ownerKey:'a',acceptedCount:999,rejectedCount:0,acceptedSample:[],rejectedSample:[]}),
  ]);
  await module.cacheStageOneGammaExportSummary({metadata:stale,ownerKey:'a',acceptedCount:999,rejectedCount:0,acceptedSample:[],rejectedSample:[]});
  await module.cacheUniversalScanSummary({metadata:stale,ownerKey:'a',summary:{}});
  const current=await module.readStageOneGammaExport({exportId:id,ownerKey:'a'});
  assert.equal(current.rows.length,2);assert.equal(current.metadata.rowCount,2);
  assert.equal(current.metadata.immutableRowsStorage,undefined);
  assert.notEqual(current.metadata.storageRevision,stale.storageRevision);
  assert.notEqual(current.metadata.acceptedCount,999);
 } finally {await cleanup();}
});

test('pinned download descriptors retain their metadata generation after a concurrent append',async()=>{
 const {root,ids,module,cleanup}=await fixture();
 let snapshot;
 try {
  const id=await module.forkUniversalScan('a',ids[0],'42');
  snapshot=await module.openStageOneGammaExportSnapshot({exportId:id,ownerKey:'a'});
  const wallet={candidate:{id:'wallet',question:'Wallet'},event:{},market:{},scanStatus:'passed',filterReasons:[]};
  await module.appendStageOneGammaExportPage({exportId:id,ownerKey:'a',pageKey:'wallet',rows:[wallet],completed:true});
  const chunks=[];
  for await(const chunk of snapshot.rows.createReadStream({start:0,autoClose:false})) chunks.push(chunk);
  const oldRows=Buffer.concat(chunks).toString().trim().split('\n');
  assert.equal(oldRows.length,snapshot.metadata.rowCount);
  assert.equal(oldRows.length,1);
  assert.equal((await module.readStageOneGammaExport({exportId:id,ownerKey:'a'})).rows.length,2);
  assert.equal(statSync(join(root,'exports',`${id}.jsonl`)).size>0,true);
 } finally {await snapshot?.close();await cleanup();}
});

test('resumable filters survive independent transactions and an interleaved wallet append',async()=>{
 const {module,cleanup}=await fixture();
 try {
  const rows=Array.from({length:5001},(_,i)=>({candidate:{id:`market-${i}`,question:`Market ${i}`},event:{},market:{},scanStatus:'passed',filterReasons:[]}));
  const capture=await module.appendStageOneGammaExportPage({exportId:null,ownerKey:'a',pageKey:'base',rows,completed:true});
  const first=await module.reapplyStageOneGammaExportFilters({exportId:capture.exportId,ownerKey:'a',filters:{},evaluate:()=>[]});
  assert.equal(first.completed,false);
  assert.equal(first.metadata.reapplyState.processedCount,5000);
  const wallet={candidate:{id:'wallet',question:'Wallet'},event:{},market:{},scanStatus:'passed',filterReasons:[]};
  await module.appendStageOneGammaExportPage({exportId:capture.exportId,ownerKey:'a',pageKey:'wallet',rows:[wallet],completed:true});
  const final=await module.reapplyStageOneGammaExportFilters({exportId:capture.exportId,ownerKey:'a',filters:{},cursor:5000,evaluate:()=>[]});
  assert.equal(final.completed,true);assert.equal(final.metadata.rowCount,5002);
  assert.equal(final.metadata.acceptedCount,5002);
 } finally {await cleanup();}
});

test('Excel legacy fallback reads a pinned generation and never replaces live filtered rows',async()=>{
 const {root,ids,module,modulePath,cleanup}=await fixture();
 try {
  const {createRequire}=await import('node:module');
  const {unzipSync,strFromU8}=await import('fflate');
  const require=createRequire(import.meta.url);
  const id=await module.forkUniversalScan('a',ids[0],'42');
  await module.reapplyStageOneGammaExportFilters({exportId:id,ownerKey:'a',filters:{},evaluate:()=>[]});
  await rm(join(root,'exports',`${id}.filtered.jsonl`));
  let source=readFileSync(join(frontend,'app/api/bullpen-ai/stage-one.xlsx/route.ts'),'utf8');
  const headers=JSON.parse(readFileSync(join(frontend,'lib/bullpenStageOneExcelColumns.json'),'utf8'));
  source=source.replace(/import exhaustiveHeaders from [^;]+;/,`const exhaustiveHeaders=${JSON.stringify(headers)};`)
   .replace(/import \{ strToU8, Zip, ZipDeflate, ZipPassThrough \} from "fflate";/,`import {strToU8,Zip,ZipDeflate,ZipPassThrough} from '${pathToFileURL(require.resolve('fflate')).href}';`)
   .replace(/import \{ NextRequest, NextResponse \} from "next\/server";/,`class NextResponse extends Response {static json(data,options){return new Response(JSON.stringify(data),options);}}`)
   .replace(/import \{ createBackendSessionContext \} from "..\/_lib\/serverBackendSession";/,`async function createBackendSessionContext(){return {hasAuthJsSession:true,accessToken:'test',sessionSubject:'a'};}`)
   .replace(/from "..\/_lib\/stageOneGammaExport";/,`from '${pathToFileURL(modulePath).href}';`);
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
  const routePath=join(root,'excel-route.mjs');writeFileSync(routePath,output);
  const route=await import(pathToFileURL(routePath).href);
  const response=await route.GET({nextUrl:new URL(`http://localhost/?exportId=${id}&scope=filtered`)});
  assert.equal(response.status,200,response.status===200?'':await response.text());
  const zip=unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.match(strFromU8(zip['xl/worksheets/sheet1.xml']),/Original question/);
  assert.equal(response.headers.get('x-bullpen-export-rows'),'1');
  assert.equal(await import('node:fs').then(fs=>fs.existsSync(join(root,'exports',`${id}.filtered.jsonl`))),false);
  // A later append is free to publish the live filtered ledger; another old
  // download never overwrites it because no Excel fallback writes that path.
  const wallet={candidate:{id:'wallet',question:'Wallet'},event:{},market:{},scanStatus:'passed',filterReasons:[]};
  await module.appendStageOneGammaExportPage({exportId:id,ownerKey:'a',pageKey:'wallet',rows:[wallet],completed:true});
  assert.match(readFileSync(join(root,'exports',`${id}.filtered.jsonl`),'utf8'),/Wallet/);
 } finally {await cleanup();}
});

for (const damage of ['reserved-full','corrupt-ledger']) test(`failed admission (${damage}) preserves shared rows, manifest and unknown claims`,async()=>{
 const {root,ids,module,cleanup}=await fixture();
 try {
  const id=await module.forkUniversalScan('a',ids[0],'42');
  const rows=join(root,'exports',`${id}.jsonl`),metadata=join(root,'exports',`${id}.json`);
  const beforeRows=readFileSync(rows),beforeMetadata=readFileSync(metadata);
  const ledgerPath=join(root,'exports/.storage-admission/claims.json');
  const pending=JSON.stringify({version:1,claims:{unknown:{identity:'unresolved-owner',pending:{[String(statSync(rows).dev)]:Number.MAX_SAFE_INTEGER}}}});
  const damaged=damage==='reserved-full'?pending:'{corrupt';
  writeFileSync(ledgerPath,damaged);
  process.env.BULLPEN_STORAGE_RESERVATIONS='0';
  const wallet={candidate:{id:'wallet',question:'Wallet'},event:{},market:{},scanStatus:'passed',filterReasons:[]};
  await assert.rejects(module.appendStageOneGammaExportPage({exportId:id,ownerKey:'a',pageKey:'wallet',rows:[wallet],completed:true}),/UPS_STORAGE_CAPACITY/);
  assert.deepEqual(readFileSync(rows),beforeRows);assert.deepEqual(readFileSync(metadata),beforeMetadata);
  assert.equal(readFileSync(ledgerPath,'utf8'),damaged);
 } finally {await cleanup();}
});
