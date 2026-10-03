import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../lib/actionableQuantityDisplay.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const sandbox={exports:{},Intl,Set,Number,Object,Math};
vm.runInNewContext(code,sandbox);
const format=sandbox.exports.formatConsolidatedQuantityCell;

test('consolidated display removes arithmetic noise without changing source values',()=>{
  const row=Object.freeze({'Current Units':'0.1234567','Units Change':'-0.12345669999999999','Final Units':'1.3877787807814457e-17'});
  assert.equal(format(row,'Current Units'),'0.1234567');
  assert.equal(format(row,'Units Change'),'-0.1234567');
  assert.equal(format(row,'Final Units'),'0');
  assert.equal(row['Final Units'],'1.3877787807814457e-17');
  assert.equal(format({'Units Change':'0.7000000000000001'},'Units Change'),'0.7');
});

test('tiny real positions and material remainders stay visible',()=>{
  assert.equal(format({'Current Units':'1e-16'},'Current Units'),'0.0000000000000001');
  assert.equal(format({'Current Units':'1','Units Change':'-0.999999999999','Final Units':'1e-12'},'Final Units'),'0.000000000001');
  assert.equal(format({'Current Units':'10000000000000000','Units Change':'-10000000000000000','Final Units':'1'},'Final Units'),'1');
});

test('zero and unknown are distinct, and non-quantity cells are untouched',()=>{
  assert.equal(format({'Final Units':'0'},'Final Units'),'0');
  assert.equal(format({'Current Units':'-0'},'Current Units'),'0');
  for(const value of ['', 'N/A', 'unknown', 'Infinity', 'NaN', '2 shares']) assert.equal(format({'Final Units':value},'Final Units'),null);
  assert.equal(format({'Price Per Unit':'0.7000000000000001'},'Price Per Unit'),null);
});
