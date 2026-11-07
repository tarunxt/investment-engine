import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const relative = 'frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx';
const root = new URL('../../', import.meta.url);
const before = execFileSync('git', ['show', '4825dfd2409a5bdf46b5c189ebede82c5c5c01d1:' + relative], { cwd: root, encoding: 'utf8' });
const after = readFileSync(new URL(relative, root), 'utf8');
function inspect(text) {
  const ast = ts.createSourceFile('schedule.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body; const controls = [];
  function visit(node) {
    if (ts.isConditionalExpression(node) && node.condition.getText(ast) === 'isTradeAmountInfoDialogOpen') {
      let surface = node.whenTrue; while (ts.isParenthesizedExpression(surface)) surface = surface.expression;
      assert.ok(ts.isJsxElement(surface)); body = surface.children.map(n => n.getText(ast));
    }
    if (ts.isJsxAttribute(node) && ['onClick', 'disabled', 'id'].includes(node.name.getText(ast))) controls.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(body); return { body, controls };
}
test('amount formula body and every existing click/disabled/id attribute equal deployed baseline', () => assert.deepEqual(inspect(after), inspect(before)));
