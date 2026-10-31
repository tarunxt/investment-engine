import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual production sorter and its helpers, without mounting the
// app, auth, portfolio APIs or a provider. No mirrored sorting implementation.
const source = readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx', import.meta.url), 'utf8');
function extract(text, names) {
  const ast = ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return names.map(name => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) ? n.name?.text === name : ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
    assert.ok(node, `production declaration ${name} exists`);
    return node.getText(ast);
  }).join('\n');
}
const helper = readFileSync(new URL('../lib/basketDisplayCalculations.ts', import.meta.url), 'utf8');
const code = extract(helper, ['basketActionGroup']) + '\n' + extract(source, [
  'ZERODHA_BASKET_SECTION_ORDER', 'ZERODHA_BASKET_INCREASING_SCORE_ACTIONS', 'ZERODHA_BASKET_DECREASING_SCORE_ACTIONS',
  'getZerodhaBasketActionForPercent', 'getZerodhaBasketScore', 'compareZerodhaBasketOrdersByScore',
]) + '\nexport {compareZerodhaBasketOrdersByScore as compare};';
const {compare} = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(code, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText).toString('base64'));
const row = (id, action, score, updates = {}) => ({id, symbol:id, exchange:'NSE', action, side:['Sell All','Trim'].includes(action)?'SELL':'BUY', percent:100, units:5, amount:500, detail:{calculatedScore:score}, draftContext:{action}, ...updates});
const ids = rows => [...rows].sort(compare).map(r => r.id);

test('default Action New hierarchy, score direction, missing scores and symbol ties', () => {
  assert.deepEqual(ids([
    row('BUY2','Buy New',2), row('TRIM2','Trim',2), row('SELL2','Sell All',2), row('BUY3','Buy New',3), row('ADD2','Add More',2),
    row('SELL1','Sell All',1), row('TRIM1','Trim',1), row('ADD3','Add More',3), row('SELLNULL','Sell All',null),
    row('SELLTIE','Sell All',2), row('HOLDZ','Hold',-5), row('HOLDA','Hold',5), row('UNKNOWN',null,null),
  ]), ['SELL1','SELL2','SELLTIE','SELLNULL','TRIM1','TRIM2','BUY3','BUY2','ADD3','ADD2','HOLDA','HOLDZ','UNKNOWN']);
});

test('decreasing and increasing Units across 100 percent cannot move a Sell All row', () => {
  const rows = [row('HAL','Sell All',-3),row('BEL','Sell All',-2),row('OIL','Sell All',-1),row('ONGC','Sell All',0),row('CGPOWER','Sell All',1)];
  const baseline = ids(rows);
  for (const units of [4,0,6,5]) {
    const edited = rows.map(r => r.id==='HAL'?{...r,units,percent:units/5*100,amount:units*4853.7}:r);
    assert.deepEqual(ids(edited),baseline);
    assert.deepEqual(edited.map(r=>r.draftContext.action),rows.map(r=>r.draftContext.action));
    assert.equal(edited[0].id,'HAL');
    assert.equal(edited[0].amount,units*4853.7);
  }
});

test('Trim, selection, Amount edits and repeated popup-style object rerenders preserve identity and order', () => {
  let rows = [row('ICICIBANK','Trim',1,{percent:40}),row('TRIMB','Trim',2,{percent:30}),row('BUY','Buy New',3)];
  const baseline=ids(rows);
  for (let i=0;i<4;i++) {
    rows=rows.map(r=>({...r,units:i+1,percent:i===2?100:20,amount:(i+1)*123.45,selected:i%2===0,detail:{...r.detail},draftContext:{...r.draftContext}}));
    assert.deepEqual(ids(rows),baseline);
  }
});

test('equal symbol and score retain source order across venues and edits; fresh scores intentionally re-sort', () => {
  const first=row('first','Sell All',1,{symbol:'SAME',exchange:'NSE'}),second=row('second','Sell All',1,{symbol:'SAME',exchange:'BSE'});
  assert.deepEqual(ids([first,second]),['first','second']);
  assert.deepEqual(ids([{...first,percent:10,units:1},second]),['first','second']);
  assert.deepEqual(ids([{...first,detail:{calculatedScore:3}},second]),['second','first']);
});

test('legacy baskets retain percent-derived action ordering', () => {
  const full=row('Z','Trim',3,{draftContext:undefined,percent:100}),partial=row('A','Sell All',-3,{draftContext:undefined,percent:80});
  assert.deepEqual(ids([partial,full]),['Z','A']);
});
