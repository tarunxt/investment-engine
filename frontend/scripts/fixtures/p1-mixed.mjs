// Synthetic browser-only action rows. Never sent to an upstream service.
export function mixedFixture(value) {
 const copy=structuredClone(value);
 const symbols=['FALP','FBET','FGAM','FDEL'];const actions=['Buy New','Add','Trim','Sell All'];
 function visit(node){if(!node||typeof node!=='object')return;
  if(typeof node.response==='string'){try{const parsed=JSON.parse(node.response);if(Array.isArray(parsed.stocks)&&parsed.stocks.length){const template=parsed.stocks[0];parsed.stocks=symbols.map((symbol,i)=>({...template,'Stock Symbol':symbol,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':actions[i],Action:actions[i],'Current Units':i===0?'0':i===1?'10':'5','Units to Buy':i<2?'2':'0','Units to Sell':i<2?'0':i===2?'2':'5','Units Change':i<2?'2':i===2?'-2':'-5','Final Units':i<2?'12':i===2?'3':'0','Total Buy Amount':i<2?'240':'0','Total Sell Amount':i<2?'0':i===2?'240':'600'}));node.response=JSON.stringify(parsed)}}catch{}}
  if(Array.isArray(node.holdings)&&node.holdings.length===2){node.holdings=[...node.holdings.filter(row=>(row.tradingsymbol??row.symbol)!=='FALP'),...['FGAM','FDEL'].map((symbol,i)=>{const row={...node.holdings[0]};if(row.tradingsymbol){Object.assign(row,{tradingsymbol:symbol,quantity:5,realised_quantity:5,opening_quantity:5,instrument_token:201+i,isin:'SYNTHETIC-MIXED-'+i,market_value:600})}else Object.assign(row,{symbol,company_name:'Synthetic '+symbol,quantity:5,current_value:600,invested_value:500});return row})];node.holdings_count=node.holdings.length;node.reported_holdings_count=node.holdings.length;}
  for(const child of Object.values(node))if(child&&typeof child==='object')visit(child);
 }
 visit(copy);return copy;
}
