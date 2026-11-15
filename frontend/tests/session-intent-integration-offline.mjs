import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import net from 'node:net';
import dns from 'node:dns';
import childProcess from 'node:child_process';
const deny=()=>{throw new Error('Session intent proof: egress/process forbidden');};
globalThis.fetch=deny;net.Socket.prototype.connect=deny;dns.lookup=dns.resolve=deny;
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[key]=deny;
const trusted=await import('../lib/trustedSessionUpdate.ts');
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const source=read('../auth.ts');
const callbackSource=source.slice(source.indexOf('    async jwt('),source.indexOf('    async session(')).trim().replace(/^async jwt/,'async function').replace(/,\s*$/,'');
const jwt=vm.runInNewContext(stripTypeScriptTypes('('+callbackSource+')',{mode:'transform'}),{
  trustedSessionReplacement:trusted.trustedSessionReplacement,Date,crypto:{randomUUID:()=> 'synthetic-new-generation'},
});
const token=()=>({id:'42',sub:'42',iat:123,sessionGeneration:'synthetic-g1',accessToken:'a0',refreshToken:'r0',accessTokenExpiresAt:0});
function backend({loseClaim=false,loseResponse=false}={}){
  const state={claimed:false,started:false,refreshes:0,claims:0,logouts:0,current:'r0'};
  let lateResolve;
  const late=new Promise(resolve=>{lateResolve=resolve;});
  return {state,finishLate:()=>lateResolve(Response.json({access_token:'a1',refresh_token:'r1',expires_in:900})),fetch:async(url,options)=>{
    assert.ok(url.startsWith('http://backend.invalid/'));
    const path=new URL(url).pathname;
    if(path==='/auth/refresh-intent'){
      state.claims++;
      if(state.claimed)return Response.json({detail:'Refresh reserved or uncertain; sign in again'},{status:409});
      state.claimed=true;
      if(loseClaim)return late;
      return Response.json({intent_nonce:'synthetic-one-way-intent'});
    }
    if(path==='/auth/refresh'){
      const body=JSON.parse(options.body);
      assert.equal(body.refresh_token,'r0');assert.equal(body.intent_nonce,'synthetic-one-way-intent');
      assert.equal(state.started,false,'exactly one refresh dispatch');state.started=true;state.refreshes++;state.current='r1';
      if(loseResponse)return late;
      return Response.json({access_token:'a1',refresh_token:'r1',expires_in:900});
    }
    if(path==='/auth/logout-refresh'){
      assert.equal(JSON.parse(options.body).refresh_token,'r0');state.logouts++;
      return Response.json({session_revocation:'confirmed'});
    }
    assert.equal(path,'/synthetic/private');
    return Response.json({synthetic:true});
  }};
}
async function worker(server){
  let cookie=token();const updates=[];
  const context=vm.createContext({Request,Response,Headers,AbortController,DOMException,URL,Date,console,
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,25)),clearTimeout,
    process:{env:{BACKEND_API_URL:'http://backend.invalid'}},fetch:server.fetch});
  const modules=new Map();
  function synthetic(id,values){const m=new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context,identifier:id});modules.set(id,m);}
  synthetic('node:crypto',{createHash});synthetic('@auth/core/jwt',{getToken:async()=>({...cookie})});
  synthetic('next/server',{NextResponse:Response});synthetic('@/lib/trustedSessionUpdate',trusted);
  synthetic('@/auth',{resolveNextAuthSecret:()=> 'synthetic-unused',unstable_update:async(data)=>{
    const next=await jwt({token:{...cookie},trigger:'update',session:data});
    updates.push({...next});cookie=next;
  }});
  const paths={session:'../app/api/bullpen-ai/_lib/serverBackendSession.ts',runtime:'../app/api/bullpen-ai/_lib/backendBullpenRuntime.ts',flight:'../lib/singleFlight.ts',transport:'../lib/boundedApiTransport.ts',cookies:'../lib/authSessionCookie.ts'};
  const aliases={'./backendBullpenRuntime':'runtime','@/lib/singleFlight':'flight','@/lib/boundedApiTransport':'transport','@/lib/authSessionCookie':'cookies'};
  function load(id){id=aliases[id]??id;if(modules.has(id))return modules.get(id);assert.ok(paths[id],`Forbidden module ${id}`);const m=new vm.SourceTextModule(stripTypeScriptTypes(read(paths[id]),{mode:'transform'}),{context,identifier:id});modules.set(id,m);return m;}
  const m=load('session');await m.link(load);await m.evaluate();
  return {api:m.namespace,updates,context:()=>m.namespace.createBackendSessionContext(new Request('http://frontend.invalid/api/synthetic'))};
}
test('two independent BFF worker contexts and delayed old cookies authorize one dispatch, no credential recovery',async()=>{
  const server=backend(),a=await worker(server),b=await worker(server);
  const results=await Promise.allSettled([a,b].map(async w=>w.api.fetchBackendJsonWithSession(await w.context(),'/synthetic/private')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  assert.equal(server.state.refreshes,1);assert.equal(a.updates.length+b.updates.length,1);
  const stale=a.updates.length?b:a;
  await assert.rejects(stale.api.fetchBackendJsonWithSession(await stale.context(),'/synthetic/private'),e=>e.status===409);
  assert.equal(server.state.refreshes,1);
  const winner=a.updates.length?a:b;
  await winner.api.fetchBackendJsonWithSession(await winner.context(),'/synthetic/private');
  assert.equal(server.state.refreshes,1);
});
for(const lost of ['claim','response'])test(`lost ${lost} outcome prohibits retry/takeover and ignores late replacement`,async()=>{
  const server=backend({loseClaim:lost==='claim',loseResponse:lost==='response'}),w=await worker(server);
  await assert.rejects(w.api.fetchBackendJsonWithSession(await w.context(),'/synthetic/private'));
  await assert.rejects(w.api.fetchBackendJsonWithSession(await w.context(),'/synthetic/private'),e=>e.status===409);
  server.finishLate();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(server.state.refreshes,lost==='claim'?0:1);assert.equal(w.updates.length,0);
});
test('expired-access logout revokes without rotating or competing for intent',async()=>{
  const server=backend(),w=await worker(server);
  const result=await w.api.fetchBackendJsonWithSession(await w.context(),'/auth/logout',{method:'POST'});
  assert.equal(result.session_revocation,'confirmed');assert.equal(server.state.logouts,1);
  assert.equal(server.state.claims,0);assert.equal(server.state.refreshes,0);assert.equal(w.updates.length,0);
});
test('actual Auth.js callback ignores client credentials and binds trusted replacement to account/generation',async()=>{
  const original=token();
  const changed=await jwt({token:{...original},trigger:'update',session:{accessToken:'attacker',refreshToken:'attacker',expiresIn:99999,id:'99'}});
  assert.equal(changed.accessToken,'a0');assert.equal(changed.refreshToken,'r0');assert.equal(changed.id,'42');
  for(const [subject,generation,expected]of [['42','synthetic-g1','a1'],['99','synthetic-g1','a0'],['42','other','a0']]){
    const result=await trusted.withTrustedSessionUpdate({subject,generation,previousRefreshToken:'r0',replacement:{accessToken:'a1',refreshToken:'r1',expiresIn:900}},()=>jwt({token:{...original},trigger:'update',session:{accessToken:'ignored'}}));
    assert.equal(result.accessToken,expected);
  }
});
test('overlapping trusted server updates cannot cross account scopes or survive completion',async()=>{
  const updates=await Promise.all(['42','43'].map(async subject=>trusted.withTrustedSessionUpdate({subject,generation:'synthetic-g1',previousRefreshToken:'r0',replacement:{accessToken:`a-${subject}`,refreshToken:`r-${subject}`,expiresIn:900}},async()=>{
    await Promise.resolve();return jwt({token:{...token(),id:subject,sub:subject},trigger:'update',session:{}});
  })));
  assert.deepEqual(updates.map(t=>t.accessToken),['a-42','a-43']);
  assert.equal(trusted.trustedSessionReplacement(token()),null);
});
