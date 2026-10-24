import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=(source,imports={})=>{const out={};const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','exports',js)(name=>{assert.ok(name in imports,`Unexpected import ${name}`);return imports[name];},out);return out;};
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const policy=compile(read('../lib/modulePolicy.ts'));
const request=compile(read('../lib/moduleRequests.ts'),{'./modulePolicy':policy});
const scope=compile(read('../lib/dashboardScope.ts'),{'./modulePolicy':policy});
const seed=JSON.parse(read('./fixtures/stage08-ready-manifest.json'));
function manifest(selected,owner=7101){const m=structuredClone(seed);m.owner_id=owner;for(const row of m.modules){row.selection.enabled=selected.includes(row.module_id);for(const c of Object.values(row.capabilities))c.allowed=row.selection.enabled&&c.capability!=='execute';}return m;}
const summary={fx:{pair:'USD/INR',value:84,source:'synthetic',as_of:'2026-10-24',age_seconds:0,status:'valid',stale_after_seconds:3600},usd_inr_rate:84,zerodha:{sentinel:'INDIA'},indmoney_us:{sentinel:'US'},bullpen:{sentinel:'HIDDEN'},sections:{zerodha:{},indmoney_us:{},bullpen:{error:'HIDDEN_ROLE_ERROR'},fx:{}},portfolio_history:{india:[1],indmoney:[2],bullpen:[3],combined:[6]}};
for(const selected of [[],['zerodha_rebalance'],['indmoney_us'],['zerodha_rebalance','indmoney_us']])test(`summary excludes off modules and errors: ${selected}`,()=>{
 const result=scope.scopeDashboardSummary(summary,manifest(selected));assert.equal(result.bullpen,null);assert.equal(result.sections.bullpen,undefined);assert.deepEqual(result.portfolio_history.bullpen,[]);assert.doesNotMatch(JSON.stringify(result),/HIDDEN/);
 assert.equal(!!result.zerodha,selected.includes('zerodha_rebalance'));assert.equal(!!result.indmoney_us,selected.includes('indmoney_us'));
 if(!selected.includes('indmoney_us'))assert.equal(result.fx.value,null);
});
test('visibility preserves setup/unavailable cards without data authority; core navigation survives failure',()=>{
 const m=manifest(['zerodha_rebalance']);m.modules[0].availability.available=false;m.modules[0].capabilities.view.allowed=false;
 assert.equal(policy.surfaceVisible(m,'/console/zerodha'),true);assert.equal(policy.surfaceAllowed(m,'/console/zerodha'),false);
 assert.equal(policy.surfaceVisible(null,'/console/dashboard'),true);assert.equal(policy.surfaceVisible(null,'/console/profile/preferences'),true);assert.equal(policy.surfaceAllowed(null,'/console/zerodha'),false);
});
test('scope cache identity separates owners, versions, disable and connection readiness',()=>{
 const m=manifest(['zerodha_rebalance']);const key=policy.moduleScopeKey(m);
 for(const change of [x=>x.owner_id++,x=>x.version++,x=>x.modules[0].selection.enabled=false,x=>x.modules[0].connection.state='missing']){const next=structuredClone(m);change(next);assert.notEqual(policy.moduleScopeKey(next),key);}
 assert.notEqual(policy.moduleScopeKey(null),key);
});
test('retained server summary cannot hydrate or seed cache across owner, session or policy transitions',()=>{
 const m=manifest(['zerodha_rebalance']);const binding={owner:m.owner_id,generation:'session-a',policy:policy.moduleScopeKey(m)};
 assert.equal(scope.acceptInitialDashboard(summary,binding,m,m.owner_id,'session-a'),summary);
 assert.equal(scope.acceptInitialDashboard(summary,binding,manifest(['zerodha_rebalance'],7102),7102,'session-b'),null);
 assert.equal(scope.acceptInitialDashboard(summary,binding,m,m.owner_id,'session-b'),null);
 assert.equal(scope.acceptInitialDashboard(summary,binding,manifest(['indmoney_us']),m.owner_id,'session-a'),null);
 assert.equal(scope.acceptInitialDashboard(summary,null,m,m.owner_id,'session-a'),null);
});
test('actual Bullpen fetch rejects off/unavailable scope before any request and aborts on deselection',async()=>{
 const source=read('../app/console/dashboard/DashboardPageClient.tsx');const tree=ts.createSourceFile('dashboard.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='fetchBullpenPositions');assert.ok(fn);
 const js=ts.transpileModule(fn.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const fetchPositions=new Function('moduleRequestSignal',js+';return fetchBullpenPositions;')(request.moduleRequestSignal);
 const old={window:globalThis.window,fetch:globalThis.fetch};let calls=[];globalThis.window={location:{origin:'https://synthetic.invalid'}};globalThis.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({positions:[]})};};
 try{request.installModulePolicy(manifest(['zerodha_rebalance']));await assert.rejects(fetchPositions(),{name:'AbortError'});assert.equal(calls.length,0);
  const m=manifest(['bullpen_research']);const row=m.modules.find(x=>x.module_id==='bullpen_research');row.availability.available=true;row.capabilities.view.allowed=true;request.installModulePolicy(m);await fetchPositions();assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,false);
  request.installModulePolicy(manifest([]));assert.equal(calls[0].options.signal.aborted,true);
 }finally{request.clearModulePolicy();globalThis.window=old.window;globalThis.fetch=old.fetch;}
 assert.match(source,/if \(!allowBullpen\) return;/);assert.match(source,/if \(allowBullpen\) void refreshBullpenTile\(false\)/);
});
test('incomplete selected funds never become a successful zero total',()=>{assert.equal(scope.completeSelectedTotal([100,null]),null);assert.equal(scope.completeSelectedTotal([]),null);assert.equal(scope.completeSelectedTotal([0]),0);assert.equal(scope.completeSelectedTotal([100,20]),120);});
