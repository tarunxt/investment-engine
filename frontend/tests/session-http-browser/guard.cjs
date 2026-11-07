// Preloaded before Next/application imports. Only this fixture's loopback ports
// may be reached. Build workers and read-only libc probes are allowlisted.
const net=require('node:net'),dns=require('node:dns'),cp=require('node:child_process');
const deny=()=>{throw new Error('Session fixture egress/process denied');};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let x=Array.isArray(args[0])?args[0][0]:args[0];if(typeof x!=='object')x={port:x,host:typeof args[1]==='string'?args[1]:'localhost'};if(![24381,24382,24383].includes(Number(x.port))||!['127.0.0.1','localhost','::1'].includes(x.host||'localhost'))return deny();return connect.apply(this,args);};
net.Socket.prototype.connectEx=deny;
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!['127.0.0.1','localhost','::1'].includes(host))return deny();return lookup.call(this,host,...args);};
for(const n of ['resolve','resolve4','resolve6'])dns[n]=deny;
const fork=cp.fork;cp.fork=function(path,...args){if(!process.env.SESSION_PROOF_BUILD||!path.includes('/node_modules/next/dist/')||!path.endsWith('/processChild.js'))return deny();return fork.call(this,path,...args);};
const spawnSync=cp.spawnSync;cp.spawnSync=function(cmd,args,...rest){if(process.env.SESSION_PROOF_BUILD&&((cmd==='getconf'&&JSON.stringify(args)==='["GNU_LIBC_VERSION"]')||(cmd==='ldd'&&JSON.stringify(args)==='["--version"]')))return spawnSync.call(this,cmd,args,...rest);return deny();};
for(const n of ['exec','execSync','execFile','execFileSync','spawn'])cp[n]=deny;
