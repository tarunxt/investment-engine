#!/usr/bin/env node
// Serial local production measurement. Uses synthetic sessions and intercepted API fixtures.
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(process.argv[2]||root),label=process.argv[3];
if(!['baseline','candidate'].includes(label))throw Error('Usage: p1-matched-performance.mjs FRONTEND_DIRECTORY baseline|candidate');
const output='/workspace/p1-private-acceptance';await mkdir(output,{recursive:true});
const port=3110,base=`http://127.0.0.1:${port}`;
const env={...process.env,BACKEND_API_URL:'http://127.0.0.1:9',API_URL:'http://127.0.0.1:9',NEXTAUTH_URL:base};
const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:source,env,stdio:['ignore','pipe','pipe']});
let serverLog='';server.stdout.on('data',data=>serverLog+=data);server.stderr.on('data',data=>serverLog+=data);
try{
 await writeFile(path.join(output,`${label}-server-pid.json`),JSON.stringify({pid:server.pid,source,port}));
 let ready=false;for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error('Local server exited '+serverLog);try{const r=await fetch(base+'/login');if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}if(!ready)throw Error('Local fixture server did not become ready');
 let script=await readFile(path.join(root,'scripts/performance-audit.mjs'),'utf8');
 script=script.replace('chromium.launch({ headless: true })','chromium.launch({ headless: true, executablePath: "/usr/bin/chromium" })');
 script=script.replace('async function configurePage(context, page, profile) {','async function configurePage(context, page, profile) {\n  await page.route("**/*", route => { const url=new URL(route.request().url()); if (url.origin===BASE_URL) return route.continue(); return route.abort(); });');
 const report=path.join(output,`${label}-performance.json`);
 const child=spawn(process.execPath,['--input-type=module'],{cwd:root,env:{...env,PERF_BASE_URL:base,PERF_OUTPUT_JSON:report,PERF_LOCAL_AUTH_SECRET:'local-auth-disabled-fallback-secret',PERF_MOCK_API:'true',PERF_RUNS:'2'},stdio:['pipe','pipe','pipe']});
 let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data)});child.stderr.on('data',data=>{log+=data;process.stderr.write(data)});child.stdin.end(script);
 const timer=setTimeout(()=>child.kill('SIGTERM'),12*60*1000);
 const exit=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);await writeFile(path.join(output,`${label}-performance.log`),log);if(exit!==0)throw Error(`Performance fixture exited ${exit}`);
 console.log(JSON.stringify({label,source,report,serverPid:server.pid}));
}finally{
 server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null)server.kill('SIGKILL');
 await writeFile(path.join(output,`${label}-server.log`),serverLog);
}
