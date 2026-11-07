import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const relative = 'frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx';
const root = new URL('../../', import.meta.url);
const before = execFileSync('git', ['show', '4825dfd2409a5bdf46b5c189ebede82c5c5c01d1:' + relative], { cwd: root, encoding: 'utf8' });
const after = readFileSync(new URL(relative, root), 'utf8');
function inspect(text) {
  const ast = ts.createSourceFile('workflow.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'InputSelectionDialog');
  assert.ok(fn);
  const controls = [], copy = [], calls = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      if (['button', 'Button', 'input', 'select', 'textarea', 'Link', 'ModelPickerDialogFrame'].includes(tag)) controls.push({ tag, attributes: node.attributes.getText(ast) });
    }
    if (ts.isJsxText(node) && node.text.trim()) copy.push(node.text.trim().replace(/\s+/g, ' '));
    if (ts.isCallExpression(node)) calls.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return { controls, copy, calls, parameters: fn.parameters.map(n => n.getText(ast)), statements: fn.body.statements.filter(n => !ts.isReturnStatement(n)).map(n => n.getText(ast)), otherSource: text.slice(0, fn.getStart(ast)) + text.slice(fn.end) };
}
test('shared scroll-body change preserves every input, ID, handler, source copy and calculation', () => {
  const a = inspect(before), b = inspect(after);
  assert.ok(a.controls.length > 5);
  assert.deepEqual(b, a);
});
