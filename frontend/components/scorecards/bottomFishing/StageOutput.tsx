import {TradingViewSymbolLink} from "@/components/shared/TradingViewSymbolLink";
import {Table as ScorecardTable} from "../ScorecardPresentation";
import type {ReactNode} from "react";
import {date, labels, num, type Output, type Stage} from "./model";

export function Table({headers,rows,empty}:{headers:string[]; rows:{key:string;cells:ReactNode[]}[];empty:string}) {
  return <ScorecardTable columns={headers} rows={rows} empty={empty}/>;
}

export function Decisions({output}:{output:Output}) {
  const {state} = output;
  const rows = state.rows ?? [];
  const entries = rows.filter(r=>r.qty);
  const amount = entries.reduce((sum,r)=>sum+(r.qty??0)*(r.price??0),0);
  return <div className="space-y-3">
    <p className="text-sm">{entries.length} sized entries · Total ₹{num(amount)} · Market data {date(state.market_as_of ?? state.at)} IST</p>
    {state.status === "partial" && <p className="text-sm text-amber-800">Partial coverage. Decisions use only the available market data.</p>}
    {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    <Table headers={["Stock","Decision","Score /100","Price ₹","Breakout ₹","Max buy ₹","Qty","Amount ₹","Stop ₹","Target ₹","Net R/R"]}
      rows={rows.map(r=>({key:r.symbol,cells:[<TradingViewSymbolLink key="stock" symbol={r.symbol}/>,r.reason,num(r.score),num(r.price),num(r.breakout),num(r.max_buy),num(r.qty),num(r.qty && r.price ? r.qty*r.price : undefined),num(r.stop),num(r.target),num(r.rr)]}))}
      empty={state.status === "failed" ? "No final basket was produced by this run." : state.at ? "No entry qualified in this run." : "Awaiting the first completed run."}/>
  </div>;
}

export function StageOutput({stage,output}:{stage:Stage;output:Output}) {
  const {state} = output;
  const query = state.screen_query?.text ?? output.settings?.screen_query;
  const scan = state.scans?.at(-1);
  const setups = Object.entries(state.setups??{});
  if (stage==="sync") {
    const kite = state.kite_sync;
    if (!kite) return <p>No Kite snapshot was saved for this run.</p>;
    return <><p>Kite portfolio synced {date(kite.captured_at)} IST · {num(kite.holdings_count)} holdings</p>
      {kite.holdings ? <>
        <p>Market value ₹{num(kite.holdings_market_value)} · Total P&amp;L ₹{num(kite.holdings_pnl)} · Available margin ₹{num(kite.available_margin)}</p>
        <Table headers={["Stock","Exchange","Qty","Avg. cost ₹","Last price ₹","Invested ₹","Market value ₹","P&L ₹","Day change %"]}
          rows={kite.holdings.map(h=>({key:h.exchange+":"+h.tradingsymbol,cells:[
            <TradingViewSymbolLink key="stock" symbol={h.exchange+":"+h.tradingsymbol}/>,h.exchange,num(h.quantity),num(h.average_price),
            num(h.last_price),num(h.invested_value),num(h.market_value),num(h.pnl),num(h.day_change_percentage)]}))}
          empty="Kite returned no holdings at this sync."/>
      </> : <p>Stock details are unavailable for this capture. Run Bottom Fishing to save a fresh portfolio.</p>}</>;
  }
  if (stage==="screen") return <><p>{setups.length} discovered · {num(scan?.current_candles)} / {num(scan?.patterns)} support patterns with a current candle</p>
    {scan?.query_passed!=null && <p>{num(scan.query_passed)} passed the query · {num(scan.query_excluded)} excluded · {num(scan.query_missing)} with missing query data</p>}
    {query && <details><summary className="cursor-pointer text-indigo-700">Query used in this run</summary><pre className="mt-2 whitespace-pre-wrap">{query}</pre></details>}
    <Table headers={["Stock","Discovered (IST)","Discovery ₹","Support ₹","Range high ₹","Setup"]} empty="No setups recorded." rows={setups.map(([k,v])=>({key:k,cells:[<TradingViewSymbolLink key="stock" symbol={k}/>,date(v.discovered),num(v.discovery),num(v.low),num(v.high),v.invalid?"Support broken":"In range at discovery"]}))}/></>;
  if (stage==="score") return <Table headers={["Stock","Score /100",...Object.values(labels),"Decision"]} empty="No scored listings recorded."
    rows={(state.rows??[]).map(r=>({key:r.symbol,cells:[<TradingViewSymbolLink key="stock" symbol={r.symbol}/>,num(r.score),...Object.keys(labels).map(k=>num(r.points?.[k])),r.reason]}))}/>;
  return <Decisions output={output}/>;
}

export function StockFlow({output}:{output:Output}) {
  const s=output.state, rows=new Map((s.rows??[]).map(r=>[r.symbol,r]));
  const symbols=Array.from(new Set([...Object.keys(s.setups??{}),...rows.keys()]));
  return <><p>{num(s.sync?.covered)} histories synced · {symbols.length} discovered · {Array.from(rows.values()).filter(r=>r.score!=null).length} scored</p>
    <Table headers={["Stock","Screen (IST)","Score /100","Stage 4 decision","Qty"]} empty="No stocks have progressed through the screen." rows={symbols.map(k=>{
      const row=rows.get(k);return {key:k,cells:[<TradingViewSymbolLink key="stock" symbol={k}/>,date(s.setups?.[k]?.discovered),num(row?.score),row?.reason??"Outside selected scorecard inputs",num(row?.qty)]};
    })}/></>;
}
