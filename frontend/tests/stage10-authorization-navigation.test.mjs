import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const values={};new Function('exports',ts.transpileModule(readFileSync(new URL('../components/connections/authorizationNavigation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(values);
test('real login navigation accepts only exact documented provider endpoint',()=>{
 assert.match(values.authorizationDestination('https://kite.zerodha.com/connect/login?v=3&api_key=fake','https://uat2.cred-x.in'),/^https:\/\/kite/);
 for(const url of ['https://evil.invalid/connect/login','https://kite.zerodha.com.evil.invalid/connect/login','javascript:alert(1)','https://kite.zerodha.com/other','https://user:secret@kite.zerodha.com/connect/login'])assert.throws(()=>values.authorizationDestination(url,'https://uat2.cred-x.in'));
});
test('fake login navigation is same-origin and explicitly gated',()=>{
 assert.equal(values.authorizationDestination('/preview-kite?redirect_params=state','http://localhost:1',true),'http://localhost:1/preview-kite?redirect_params=state');
 assert.throws(()=>values.authorizationDestination('/preview-kite','http://localhost:1'));
 assert.throws(()=>values.authorizationDestination('https://kite.zerodha.com/connect/login','http://localhost:1',true));
 assert.throws(()=>values.authorizationDestination('http://localhost:2/preview-kite','http://localhost:1',true));
});
test('callback parsing requires exactly one state attempt and request token',()=>{
 assert.deepEqual(values.returnedAuthorization('?state=fake-state&attempt_id=fake-attempt&request_token=fake-token'),{state:'fake-state',attempt_id:'fake-attempt',request_token:'fake-token'});
 assert.equal(values.returnedAuthorization(''),null);
 for(const search of ['?request_token=fake','?state=a&state=b&attempt_id=c&request_token=fake','?state=a&attempt_id=c&request_token=fake&request_token=other'])assert.throws(()=>values.returnedAuthorization(search));
});
