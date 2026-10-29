import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const zone={};new Function('exports',compile('../lib/conceptFProfile.ts'))(zone);
const model={};new Function('require','exports',compile('../lib/conceptFPreferences.ts'))(id=>{assert.equal(id,'./conceptFProfile');return zone;},model);
test('ordinary preferences preserve exact valid saved choices, including canonical and legacy India zones',()=>{
 for(const timezone of ['UTC','Asia/Kolkata','Asia/Calcutta','Australia/Sydney']){
  const value={timezone,notification_preferences:'important',theme_preference:'system'};
  assert.deepEqual(model.savedPreferences({...value,user_id:999,credential:'not a preference'}),value);
  assert.equal(model.preferencesReady(value),true);
 }
});
test('unavailable or unsupported saved fields never become invented UTC/all/light defaults',()=>{
 for(const value of [null,undefined,[],{},'bad',{timezone:'Invalid/Invented',notification_preferences:'urgent-external',theme_preference:'automatic'}]){
  const draft=model.savedPreferences(value);
  assert.deepEqual(draft,{timezone:'',notification_preferences:'',theme_preference:''});
  assert.equal(model.preferencesReady(draft),false);
 }
});
test('a valid partial record still requires explicit choices for each unresolved field',()=>{
 const draft=model.savedPreferences({timezone:'Asia/Kolkata',notification_preferences:'none',theme_preference:{value:'light'}});
 assert.deepEqual(draft,{timezone:'Asia/Kolkata',notification_preferences:'none',theme_preference:''});
 assert.equal(model.preferencesReady(draft),false);
 assert.equal(model.preferencesReady({...draft,theme_preference:'light'}),true);
});
