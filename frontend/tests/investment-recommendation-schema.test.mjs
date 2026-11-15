import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../components/InvestmentRecommendationTable.tsx', import.meta.url), 'utf8');
const dependencies = {
  '@/components/shared/MarkdownRenderer': { default: ({ content }) => createElement('pre', null, content) },
  '@/components/shared/TradingViewSymbolLink': { TradingViewSymbolLink: ({ children }) => createElement('span', null, children) },
  '@/lib/actionColorScheme': { getStandardActionTextClass: () => '' },
  '@/lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
};
const compiled = ts.transpileModule(`${source}\nexport { SWING_HEADER_ORDER };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'module', 'require', compiled)(loaded.exports, loaded, (name) => dependencies[name] ?? require(name));
const parser = loaded.exports;

function fixture(headers, symbol) {
  const values = {
    'Exchange Symbol': 'NSE', 'Stock Symbol': symbol, 'Stock Name': `${symbol} company`,
    'LLM Name + Model': 'Fixture model', LLM: 'Fixture', 'Run #': '42',
    'Run Date': '2026-10-03', 'Run Time': '12:00', 'Current Units': '0',
    'Action (Buy/Add/Sell All/Trim/Hold/Buy New)': 'Buy New',
    'Units Change': '5', 'Final Units': '5', 'Units to Buy': '5',
    'Price per Unit': '100', 'Price Per Unit': '100', 'Total Buy Amount': '500',
    'Upside Horizon (%)': '20', 'Upside Horizon (% return)': '20',
    Weeks: '4', 'Confidence Score (0-100)': '75',
  };
  return Object.fromEntries(headers.map((header, index) => [header,
    values[header] ?? (header.startsWith('Score ') ? '3' : `${symbol} evidence ${index}`)]));
}
function contentFor(format, headers, rows) {
  return format === 'json' ? JSON.stringify({ stocks: rows }) : [
    `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => row[header]).join(' | ')} |`),
  ].join('\n');
}
for (const format of ['json', 'markdown']) {
  test(`Swing ${format} retains every source field and independent row in its rendered schema`, () => {
    const headers = parser.SWING_HEADER_ORDER;
    assert.equal(headers.length, 31);
    const rows = ['ONE', 'TWO'].map((symbol) => fixture(headers, symbol));
    const content = contentFor(format, headers, rows);
    const parsed = parser.parseInvestmentRecommendationContent(content);
    assert.deepEqual(parsed.headers, headers);
    assert.equal(parsed.rows.length, 2);
    for (const [index, row] of parsed.rows.entries()) {
      for (const header of headers) assert.equal(row[header], rows[index][header], header);
    }
    const html = renderToStaticMarkup(createElement(parser.default, { content }));
    assert.equal((html.match(/<th(?:\s|>)/g) ?? []).length, 31);
    assert.equal((html.match(/<td(?:\s|>)/g) ?? []).length, 62);
    for (const row of rows) assert.ok(html.includes(row['Stock Name']));
    assert.doesNotMatch(html, /Current Units|Units Change|Final Units/);
  });
  test(`Rebalance ${format} preserves 29 columns, zero holdings and signed changes`, () => {
    const headers = parser.REBALANCE_HEADER_ORDER;
    const row = fixture(headers, 'NEW');
    const sold = { ...row, 'Stock Symbol': 'EXIT', 'Current Units': '0.75',
      'Action (Buy/Add/Sell All/Trim/Hold/Buy New)': 'Sell All', 'Units Change': '-0.75',
      'Final Units': '0', 'Units to Buy': '0.75', 'Total Buy Amount': '75' };
    const content = contentFor(format, headers, [row, sold]);
    const parsed = parser.parseInvestmentRecommendationContent(content);
    assert.deepEqual(parsed.headers, headers);
    assert.equal(parsed.rows[0]['Current Units'], '0');
    assert.equal(parsed.rows[1]['Units Change'], '-0.75');
    assert.equal(parsed.rows[1]['Final Units'], '0');
    const html = renderToStaticMarkup(createElement(parser.default, { content }));
    assert.equal((html.match(/<th(?:\s|>)/g) ?? []).length, 29);
    assert.equal((html.match(/<td(?:\s|>)/g) ?? []).length, 58);
  });
}
test('the short Action alias still selects Rebalance', () => {
  const row = fixture(parser.REBALANCE_HEADER_ORDER, 'ALIAS');
  row.Action = row['Action (Buy/Add/Sell All/Trim/Hold/Buy New)'];
  delete row['Action (Buy/Add/Sell All/Trim/Hold/Buy New)'];
  const parsed = parser.parseInvestmentRecommendationContent(JSON.stringify([row]));
  assert.deepEqual(parsed.headers, parser.REBALANCE_HEADER_ORDER);
  assert.equal(parsed.rows[0]['Action (Buy/Add/Sell All/Trim/Hold/Buy New)'], 'Buy New');
});
