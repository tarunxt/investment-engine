import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source=readFileSync(new URL('../lib/portfolioTimestamp.ts',import.meta.url),'utf8');
const context={exports:{},Intl,Date};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const format=context.exports.formatPortfolioTimestamp;
test('UTC and offset metadata resolve to the same IST instant across midnight',()=>{
 assert.equal(format('2026-10-20T23:49:00Z'),format('2026-10-21T05:19:00+05:30'));
 assert.match(format('2026-10-20T23:49:00Z'),/21 Oct 2026, 5:19 am IST \(UTC\+05:30\)/);
 assert.match(format('2026-10-20T14:49:00Z',true),/8:19 pm IST/);
});
test('absent, invalid and timezone-less times stay unknown',()=>{
 for(const value of [null,undefined,'','2026-10-20','2026-10-20T14:49:00']) assert.match(format(value),/Not recorded/);
 assert.match(format('invalidTZ'),/Not recorded/);
});
