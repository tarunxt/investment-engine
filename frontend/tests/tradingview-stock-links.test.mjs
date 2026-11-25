import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { chartBindings as chart } from './fixtures/tradingview-bindings.mjs';

test('grid stock labels use their own listing and the recorded exchange', () => {
  const identity = chart.stockIdentityForColumns(['Company', 'Ticker', 'Exchange'], ['Example Ltd', 'M&M', 'NSE']);
  for(const [label,value] of [['Company','Example Ltd'],['Ticker','M&M']]) {
    const html = renderToStaticMarkup(chart.stockTableCell(label,value,identity));
    assert.match(html,/href="https:\/\/www.tradingview.com\/chart\/\?symbol=NSE%3AM%26M"/);
    assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  }
  assert.match(renderToStaticMarkup(chart.stockTableCell('Listing','BSE:500325',identity)),/BSE%3A500325/);
  assert.match(renderToStaticMarkup(chart.stockTableCell('Second listing','NYSE:BRK.B',identity)),/NYSE%3ABRK.B/);
  assert.equal(chart.chartSymbolForCell('Stock','Apple',{symbol:'NASDAQ:AAPL'}),'NASDAQ:AAPL');
  assert.equal(chart.stockTableCell('Status','HOLD',identity),'HOLD');
  assert.equal(chart.stockTableCell('Company','Unresolved Company Ltd',{symbol:'',exchange:''}),'Unresolved Company Ltd');
});

test('qualified mentions handle punctuation, class shares, multiple venues and URLs', () => {
  const line='NSE:ONGC, BSE:500325 and NYSE:BRK.B. Compare NSE:M&M with NSE:BAJAJ-AUTO. Run:123 https://example.test/?q=NSE:INFY';
  const parts = chart.tradingViewMentions(line);
  assert.deepEqual(parts.map(p=>p.symbol),['NSE:ONGC','BSE:500325','NYSE:BRK.B','NSE:M&M','NSE:BAJAJ-AUTO']);
  assert.ok(parts.every(p=>line.slice(p.start,p.end)===p.symbol));
  assert.equal(chart.buildTradingViewChartUrl({symbol:'NYSEARCA:SPY',market:'us'}),'https://www.tradingview.com/chart/?symbol=AMEX%3ASPY');
});

test('Markdown links names from row metadata and preserves explicit links and code', () => {
  const cell = value=>({type:'tableCell',children:[{type:'text',value}]});
  const row = values=>({type:'tableRow',children:values.map(cell)});
  const original = {type:'link',url:'https://example.test/source',children:[{type:'text',value:'NSE:INFY'}]};
  const tree = {type:'root',children:[{type:'paragraph',children:[{type:'text',value:'NSE:ONGC vs BSE:500325'},original,{type:'inlineCode',value:'NSE:EXAMPLE'}]},
    {type:'table',children:[row(['Stock name','Stock symbol','Exchange']),row(['Example Inc','EX','NASDAQ'])]}]};
  chart.remarkTradingView()(tree);
  const links=tree.children[0].children.filter(c=>c.type==='link');
  assert.equal(links.length,3);
  assert.equal(links[2],original);
  assert.equal(original.children[0].type,'text');
  for (const c of tree.children[1].children[1].children.slice(0,2)) assert.equal(c.children[0].url,'https://www.tradingview.com/chart/?symbol=NASDAQ%3AEX');
});
