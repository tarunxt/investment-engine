import './guard.cjs';
import fs from 'node:fs';import https from 'node:https';import {createRequire}from'node:module';
const root=process.env.SESSION_PROOF_FRONTEND;if(!root)throw Error('Isolated frontend required');
const require=createRequire(root+'/package.json');const next=require('next');
const app=next({dev:false,dir:root});await app.prepare();const handler=app.getRequestHandler();
const server=https.createServer({key:fs.readFileSync(process.env.SESSION_PROOF_KEY),cert:fs.readFileSync(process.env.SESSION_PROOF_CERT)},(req,res)=>{req.headers['x-forwarded-proto']='https';handler(req,res);});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('SESSION_PROOF_READY',process.pid));
process.on('SIGTERM',()=>{server.close();process.exit(0);});
