import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const expected = {
  sync: 'Sync Portfolio', threats: 'Threats Scan', swing: 'Swing Scan',
  rebalance: 'Rebalance', technical: 'Technical Scan', actionables: 'Actionables',
};
const source = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const tile = source('../components/shared/WorkflowStageTile.tsx');
const workflow = source('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx');
function declaration(text, name) {
  const ast = ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = 'const ' + node.getText(ast) + ';';
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, 'Production declaration exists: ' + name);
  return found.replace(/^export /, '');
}
function evaluate(text, names, bindings = {}) {
  const evaluated = { exports: {} };
  const code = ts.transpileModule(names.map(name => declaration(text, name)).join('\n') + '\nexport {' + names.join(',') + '};', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', ...Object.keys(bindings), code)(evaluated.exports, ...Object.values(bindings));
  return evaluated.exports;
}
const { STAGE_METADATA, getStageTileLabel } = evaluate(tile, ['STAGE_METADATA', 'getStageTileLabel']);

test('all six stage card names and metadata have one canonical primary name', () => {
  assert.deepEqual(Object.keys(STAGE_METADATA).sort(), Object.keys(expected).sort());
  for (const [key, name] of Object.entries(expected)) {
    assert.equal(getStageTileLabel(key), name);
    assert.equal(STAGE_METADATA[key].idle, name);
    if (key !== 'sync') {
      assert.ok(STAGE_METADATA[key].running.includes(name));
      assert.ok(STAGE_METADATA[key].completed.includes(name));
    }
  }
});

test('duration names, ledger names and model headings use canonical production metadata', () => {
  const { getStageLabel, getLlmSelectorTitle, getLlmSelectorScanLabel } = evaluate(workflow, ['getStageLabel', 'getLlmSelectorScanLabel', 'getLlmSelectorTitle'], { STAGE_METADATA, formatInrCost: () => 'n/a' });
  for (const [key, name] of Object.entries(expected)) {
    assert.equal(getStageLabel(key, 'idle'), name);
    for (const portfolio of ['zerodha', 'indmoneyUs']) {
      assert.ok(getLlmSelectorScanLabel(key, portfolio).startsWith(name + ' '));
      assert.ok(getLlmSelectorTitle(key, portfolio).includes(name));
    }
  }
  for (const text of [tile, source('../components/shared/WorkflowStageLedger.tsx')]) {
    assert.match(text, /Show duration breakdown for \$\{(?:stageMeta|STAGE_METADATA\[item.stage\])\.idle\}/);
    assert.match(text, /stageLabel=\{(?:stageMeta\.idle|durationStage \? STAGE_METADATA\[durationStage.stage\]\.idle : "")\}/);
  }
});

test('input titles, prompt titles and saved run labels repeat the card name', () => {
  const { titleByStage } = evaluate(workflow, ['titleByStage'], { getStageTileLabel });
  for (const key of ['threats', 'swing', 'rebalance', 'technical', 'actionables']) {
    assert.equal(titleByStage[key], 'Select ' + expected[key] + ' inputs');
  }
  const history = evaluate(source('../app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx'), ['STAGE_LABELS'], { getStageTileLabel });
  assert.deepEqual(history.STAGE_LABELS, expected);
  let prompt;
  const { showStagePrompt } = evaluate(workflow, ['showStagePrompt'], {
    useCallback: fn => fn, getStageTileLabel, getStagePromptPreview: () => 'Offline template',
    setPromptDialog: value => { prompt = value; },
  });
  for (const [portfolio, label] of [['zerodha', 'Zerodha'], ['indmoneyUs', 'INDmoney US']]) {
    for (const key of ['threats', 'swing', 'rebalance', 'technical']) {
      showStagePrompt(portfolio, key);
      assert.equal(prompt.title, label + ' ' + expected[key] + ' prompt');
    }
  }
  assert.match(workflow, /STAGE_METADATA\[stage\]\.idle\} Output/);
});
