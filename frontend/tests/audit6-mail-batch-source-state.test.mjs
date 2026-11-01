import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const require=createRequire(import.meta.url);
const file=new URL('../app/console/mails/page.tsx',import.meta.url);
const source=readFileSync(file,'utf8');
const baseline=execFileSync('git',['show','968ac9c1:frontend/app/console/mails/page.tsx'],{encoding:'utf8'});
function component(text){
  const ast=ts.createSourceFile('mails.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  assert.equal(ast.parseDiagnostics.length,0);
  const functions=['formatActionStatus','SellBatchPreparation'].map(name=>ast.statements.find(node=>node.name?.text===name).getText(ast)).join('\n');
  const compiled=ts.transpileModule(functions,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const exports={};new Function('exports','require',compiled+'\nexports.Component=SellBatchPreparation;')(exports,require);return exports.Component;
}
const Current=component(source),Original=component(baseline);
const render=(props={},Component=Current)=>renderToStaticMarkup(React.createElement(Component,{history:[],verified:false,loading:false,error:null,...props}));
function alert(id,market,odds,proceeds){return{id,subject:'Synthetic '+market,created_at:'2026-11-01T00:00:00Z',warnings:[],sell_action:{status:'detected',evaluated_at:'2026-11-01T00:01:00Z',evaluated_market_id:market,market_question:'Synthetic '+market,position_side:'YES',live_held_side_bullpen_odds:odds,sell_threshold:80,shares:10,average_sell_price:50,expected_proceeds:proceeds}};}

test('initial loading and failed mail reads leave all four metrics unknown without empty claims',()=>{
  for(const props of [{loading:true},{error:'Synthetic unavailable'}]){
    const html=render(props);assert.equal((html.match(/>Unknown<\/p>/g)||[]).length,4);assert.doesNotMatch(html,/\$0\.00|No evaluated Sell|No Sell alerts|<table/);
    assert.match(html,props.loading?/Loading mail-history source/:/Mail-history source unavailable/);
  }
});
test('verified empty history shows scoped zeros and no global batch assertion',()=>{
  const html=render({verified:true});assert.equal((html.match(/>0<\/p>/g)||[]).length,3);assert.match(html,/\$0\.00/);assert.match(html,/No evaluated Sell alerts are present in these mail-history records/);assert.match(html,/covers those records only/);
});
test('populated records retain the exact baseline financial table and aggregate',()=>{
  const history=[alert(1,'included',70,12.5),alert(2,'recovered',85,8),alert(3,'unverified',undefined,4)];
  const html=render({history,verified:true}),before=render({history},Original);assert.match(html,/\$12\.50/);assert.equal(html.match(/<tbody[\s\S]*?<\/tbody>/)[0],before.match(/<tbody[\s\S]*?<\/tbody>/)[0]);assert.equal((html.match(/>1<\/p>/g)||[]).length,3);
});
test('verified empty and populated snapshots remain qualified as cached during refresh and failure',()=>{
  for(const history of [[],[alert(1,'included',70,12.5)]])for(const state of [{loading:true},{error:'Synthetic unavailable'}]){
    const html=render({history,verified:true,...state});assert.match(html,/Showing cached mail-history records/);assert.match(html,/Current Sell batch state is unverified/);assert.doesNotMatch(html,/>Unknown<\/p>/);assert.match(html,history.length?/\$12\.50/:/No evaluated Sell alerts are present in these mail-history records/);
  }
});
test('batch source props use only the existing mail-history lifecycle',()=>{
  assert.match(source,/<SellBatchPreparation history=\{history\} verified=\{historyVerified\} loading=\{historyLoading\} error=\{historyError\}/);
  const start=source.indexOf('function SellBatchPreparation'),end=source.indexOf('export default function MailsPage',start);assert.doesNotMatch(source.slice(start,end),/fetch\(|apiService\./);
});
test('all click handlers and disabled expressions remain identical to deployed baseline',()=>{
  function attributes(text){const ast=ts.createSourceFile('mails.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),values=[];function visit(node){if(ts.isJsxAttribute(node)&&['onClick','disabled'].includes(node.name.getText(ast)))values.push(node.getText(ast));ts.forEachChild(node,visit);}visit(ast);return values;}
  assert.deepEqual(attributes(source),attributes(baseline));
});
