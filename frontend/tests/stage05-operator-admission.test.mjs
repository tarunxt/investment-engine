import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import ts from 'typescript';

function admission({role='user',active=true,authenticated=true,error=null}={}) {
  const calls=[];
  const session={hasAuthJsSession:authenticated,accessToken:authenticated?'synthetic':null};
  class BackendRuntimeHttpError extends Error { constructor(status){super();this.status=status;} }
  const exports={};
  const source=readFileSync(new URL('../app/api/bullpen-ai/_lib/operatorAdmission.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const require=(name)=>{
    if(name==='next/server')return {NextResponse:{json:(body,init)=>({body,...init})}};
    if(name==='./backendBullpenRuntime')return {BackendRuntimeHttpError};
    if(name==='./serverBackendSession')return {
      createBackendSessionContext:async()=>session,
      fetchBackendJsonWithSession:async(ctx,path,options)=>{calls.push({ctx,path,options}); if(error)throw error===true?new Error('offline'):new BackendRuntimeHttpError(error);return {role,is_active:active};},
    };
    throw new Error(name);
  };
  new Function('require','exports',compiled)(require,exports);
  return {run:()=>exports.requireBullpenOperator(new Request('http://localhost/api/bullpen-ai')),calls,session};
}
for(const [name,options,status] of [
  ['anonymous',{authenticated:false},401],['ordinary',{},403],
  ['inactive-admin',{role:'admin',active:false},403],
  ['cost-only',{role:'cost_dashboard_admin'},403],
  ['backend-offline',{error:true},503],['revoked-session',{error:401},401],
  ['backend-forbidden',{error:403},403],
])test(`BFF ${name} fails before cached data`,async()=>{
  const fixture=admission(options);const result=await fixture.run();
  assert.equal(result.response.status,status);assert.equal(result.response.headers['Cache-Control'],'no-store');
  assert.equal(fixture.calls.length,options.authenticated===false?0:1);
});
test('current active admin uses the same authenticated refresh context and bounded no-cache lookup',async()=>{
  const fixture=admission({role:'admin'});const result=await fixture.run();
  assert.equal(result.response,null);assert.equal(result.session,fixture.session);
  assert.equal(fixture.calls[0].ctx,fixture.session);assert.equal(fixture.calls[0].path,'/auth/me');
  assert.ok(fixture.calls[0].options.signal instanceof AbortSignal);
});
test('every Bullpen HTTP handler admits before cache/parse/dispatch',()=>{
  const root=new URL('../app/api/',import.meta.url);
  function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(new URL(d.name+'/',dir)):d.name==='route.ts'?[new URL(d.name,dir)]:[]);}
  const files=[...walk(new URL('bullpen-ai/',root)),new URL('universal-polymarket-scan/auto-run/route.ts',root)];
  assert.equal(files.length,11);
  let count=0;
  for(const file of files){
    const source=readFileSync(file,'utf8');
    for(const match of source.matchAll(/export async function (GET|POST)\(request: NextRequest\) \{\s*([^}]+)/g)){
      assert.match(match[2],/^const admission = await requireBullpenOperator\(request\);\s*if \(admission.response\) return admission.response;/);
      count++;
    }
  }
  assert.equal(count,13);
});
