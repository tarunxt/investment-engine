/** Synthetic browser evidence only, never full release/provider acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import path from 'node:path';
export function isolatedEnvironment(baseUrl, executablePath, networkGuard, ports) {
 const url=new URL(baseUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');
 return {PATH:executablePath,HOME:'/tmp',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_DISABLE_AUTH:'false',NEXTAUTH_SECRET:'local-playwright-auth-hardening-secret',AUTH_SECRET:'local-playwright-auth-hardening-secret',NEXTAUTH_URL:baseUrl,AUTH_URL:baseUrl,AUTH_TRUST_HOST:'true',INTERNAL_API_URL:'http://127.0.0.1:1',BACKEND_API_URL:'http://127.0.0.1:1',API_URL:'http://127.0.0.1:1',NEXT_PUBLIC_API_URL:'http://127.0.0.1:1',STAGE01_ALLOWED_PORTS:`${ports},1`,NODE_OPTIONS:`--require=${networkGuard}`,CREDX_RECOVERY_MODE:'0',ZERODHA_RECOVERY_MANUAL_ORDERS_ENABLED:'false'};
}
export const REQUIRED_CHECKS=["delayed_bootstrap","auth_failure_states","module_routes","preference_races_account_switch_mobile"];
export function browserReceipt({sourceSha,files,checks,load}) {
 assert.match(sourceSha,/^[a-f0-9]{40}$/);assert.deepEqual(checks.map(c=>c.name).sort(),[...REQUIRED_CHECKS].sort());assert(checks.every(c=>c.passed===true&&Number.isFinite(c.duration_seconds)&&c.duration_seconds>=0));assert(files.length===6&&new Set(files).size===6);
 assert.equal(load.configured_concurrency,3);assert(Number.isFinite(load.duration_seconds)&&load.duration_seconds>=0);assert(Number.isInteger(load.observed_peak_concurrency));assert(Number.isFinite(load.p95_seconds)&&load.p95_seconds>=0);assert.equal(load.threshold_seconds,10);assert.equal(load.completed,12);assert.equal(load.errors,0);assert(load.observed_peak_concurrency>=1&&load.observed_peak_concurrency<=3);assert(load.p95_seconds<=load.threshold_seconds);
 return {kind:'synthetic_loopback_browser_subset',source_sha:sourceSha,source_files_sha256:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),checks,load,synthetic_backend_responses:true,full_release_verified:false,real_provider_certification:false,deployed_uat2_verified:false,production_capacity_verified:false,capacity_target:'Unresolved. This measures only 12 synthetic browser navigations, cap 3.'};
}

export function buildContentDigest(root) {
 const entries=[];
 function walk(relative='') {
  for(const name of readdirSync(path.join(root,relative)).sort()) {
   const rel=path.join(relative,name);if(rel==='cache'||rel==='trace')continue;
   const file=path.join(root,rel),stat=lstatSync(file);
   if(stat.isSymbolicLink())throw new Error('Build symlink cannot be attested');
   if(stat.isDirectory())walk(rel);
   else if(stat.isFile())entries.push([rel,createHash('sha256').update(readFileSync(file)).digest('hex')]);
  }
 }
 walk();assert(entries.length>0);
 return {files:entries.length,sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),excluded:['cache','trace']};
}
