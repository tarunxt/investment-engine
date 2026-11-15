import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../components/InvestmentRecommendationTable.tsx', import.meta.url), 'utf8');

function loadParser() {
  const errors = [];
  const rawContent = [];
  const dependencies = {
    '@/components/shared/MarkdownRenderer': {
      default: ({ content }) => {
        rawContent.push(content);
        return createElement('pre', null, content);
      },
    },
    '@/components/shared/TradingViewSymbolLink': {
      TradingViewSymbolLink: ({ children }) => createElement('span', null, children),
    },
    '@/lib/actionColorScheme': { getStandardActionTextClass: () => '' },
    '@/lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'module', 'require', 'console', compiled)(
    loaded.exports, loaded, (name) => dependencies[name] ?? require(name),
    { error: (...args) => errors.push(args) },
  );
  return { ...loaded.exports, errors, rawContent };
}

const stockRows = ['ONE', 'TWO', 'THREE'].map((symbol) => ({
  'Exchange Symbol': 'NSE', 'Stock Symbol': symbol,
  'Current Units': '10', 'Action': 'Hold',
  'Rationale Cruxx': '[analyst](https://example.com/source) {support}',
}));
const markdown = [
  '| Exchange Symbol | Stock Symbol | Current Units | Action | Rationale Cruxx |',
  '| --- | --- | --- | --- | --- |',
  ...stockRows.map((row) => `| ${Object.values(row).join(' | ')} |`),
].join('\n');
const context = { provider: 'openai', model: 'fixture-model', runNumber: 42, runCreatedAt: '2026-10-01T12:00:00Z' };

test('plain and fenced JSON preserve every recommendation and source metadata', () => {
  const parser = loadParser();
  for (const value of [stockRows, { title: 'Fixture', stocks: stockRows }]) {
    const json = JSON.stringify(value);
    for (const content of [json, `\x60\x60\x60json\n${json}\n\x60\x60\x60`, `\x60\x60\x60\n${json}\n\x60\x60\x60`]) {
      const parsed = parser.parseInvestmentRecommendationContent(content, context);
      assert.deepEqual(parsed.rows.map((row) => row['Stock Symbol']), ['ONE', 'TWO', 'THREE']);
      assert.ok(parsed.rows.every((row) => row['Run #'] === '42' && row['LLM Name + Model'].includes('fixture-model')));
      assert.equal(parsed.rows[0]['Rationale Cruxx'], stockRows[0]['Rationale Cruxx']);
    }
  }
  assert.deepEqual(parser.errors, []);
});

test('fenced Markdown source references recover all rows without false JSON errors', () => {
  const parser = loadParser();
  const expected = parser.parseInvestmentRecommendationContent(markdown, context);
  assert.equal(expected.rows.length, stockRows.length);
  for (const language of ['', 'markdown', 'json']) {
    const content = `\x60\x60\x60${language}\n${markdown}\n\x60\x60\x60`;
    assert.deepEqual(parser.parseInvestmentRecommendationContent(content, context), expected);
    const html = renderToStaticMarkup(createElement(parser.default, { content, ...context }));
    for (const row of stockRows) assert.ok(html.includes(row['Stock Symbol']));
  }
  assert.deepEqual(parser.errors, []);
  assert.deepEqual(parser.rawContent, []);
});

test('a failed JSON candidate followed by a valid table retains the existing Markdown fallback', () => {
  const parser = loadParser();
  const content = `{this is a preamble, not JSON}\n\n${markdown}`;
  assert.equal(parser.parseInvestmentRecommendationContent(content).rows.length, stockRows.length);
  assert.deepEqual(parser.errors, []);
});

test('terminal invalid JSON remains a reported error and the complete original output is rendered', () => {
  const parser = loadParser();
  const content = '\x60\x60\x60json\n{"stocks": [{"Stock Symbol": "BROKEN"}\n\x60\x60\x60';
  assert.equal(parser.parseInvestmentRecommendationContent(content), null);
  assert.equal(parser.errors.length, 1);
  assert.ok(parser.errors[0][1] instanceof SyntaxError);
  const html = renderToStaticMarkup(createElement(parser.default, { content }));
  assert.ok(html.includes('BROKEN'));
  assert.deepEqual(parser.rawContent, [content]);
  assert.equal(parser.errors.length, 2);
});

test('unsupported JSON and upstream error text remain visible as original output', () => {
  const parser = loadParser();
  for (const content of ['{"error":"Upstream 502 Bad Gateway"}', 'The response could not be generated: 502 Bad Gateway']) {
    assert.equal(parser.parseInvestmentRecommendationContent(content), null);
    assert.match(renderToStaticMarkup(createElement(parser.default, { content })), /502 Bad Gateway/);
  }
  assert.deepEqual(parser.rawContent, ['{"error":"Upstream 502 Bad Gateway"}', 'The response could not be generated: 502 Bad Gateway']);
});
