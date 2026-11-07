import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const auth = readFileSync(new URL('../auth.ts', import.meta.url),'utf8');
const baseline = execFileSync('git',['show','bc773cd4892529ccccae5b9703d8abf43dc66fa9:frontend/auth.ts'],{encoding:'utf8'});
const core = readFileSync(new URL('../node_modules/@auth/core/lib/utils/env.js',import.meta.url),'utf8');
const tree = ts.createSourceFile('env.js',core,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const fn = tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='setEnvDefaults').getText(tree).replace(/^export /,'');
const setDefaults = new Function('setLogger',fn+';return setEnvDefaults;')(()=>({warn(){}}));
test('deployed explicit trustHost remains unchanged and absence of environment override does not change effective host trust',()=>{
 assert.match(auth,/trustHost: true/);assert.match(baseline,/trustHost: true/);
 const present={trustHost:true,providers:[]},absent={trustHost:true,providers:[]};
 setDefaults({NODE_ENV:'production',AUTH_TRUST_HOST:'true'},present);
 setDefaults({NODE_ENV:'production'},absent);
 assert.equal(present.trustHost,true);assert.equal(absent.trustHost,true);
});
test('installed Auth.js defaults do not override explicitly disabled trust',()=>{
 const config={trustHost:false,providers:[]};setDefaults({NODE_ENV:'production',AUTH_TRUST_HOST:'true'},config);assert.equal(config.trustHost,false);
});
