import Link from "next/link";
import {useState} from "react";
import {defaultDiscovery,thresholdName,filterKeys} from "./DiscoveryEditor";
import type {Model} from "./useBottomFishing";
import {route} from "./model";
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

export function CloudResults({output,model}:{output?:Output|null;model:Model}) {
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  const data=model.data;
  const discovery=data?.settings.discovery??defaultDiscovery;
  async function setMinimum(minimum:number) {
    if(!data||busy||minimum===discovery.minimum)return;
    setBusy(true);setError("");
    try{await model.save({...data.settings,discovery:{...discovery,minimum}},data.version);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  const chooser=<select aria-label="Minimum discovery filters to pass" value={discovery.minimum} disabled={busy||!data}
    className="rounded border border-indigo-300 bg-white px-2 py-1 font-semibold text-indigo-800" onChange={e=>void setMinimum(Number(e.target.value))}>
    {[5,4,3,2].map(n=><option key={n} value={n}>{thresholdName(n)}</option>)}</select>;
  const current=output && (!output.version || output.version===data?.version);
  return <><Link className="inline-block rounded-full border border-indigo-200 px-4 py-2 text-sm font-semibold text-indigo-800" href={route+"/screen?view=columns"}>Edit Columns</Link>
    {error&&<p role="alert">{error}</p>}
    {current && output?.state.original_results ? <StageOutput stage="screen" output={output} model={model} chooser={chooser}/> :
      <>{chooser}{current && output?.state.setups ? <StageOutput stage="screen" output={output}/> : <p role="status">Waiting for cloud results for the current saved query.</p>}</>}
  </>;
}

export function StageOutput({stage,output,model,chooser}:{stage:Stage;output:Output;model?:Model;chooser?:ReactNode}) {
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
  if (stage==="screen" && (query || state.original_results)) {
    const report = state.original_results;
    const cloud = output.mode==="Cloud screen" || report?.source==="Cred-X cloud";
    const filters = filterKeys;
    const minimum=report?.minimum??output.settings?.discovery?.minimum??5;
    const label=thresholdName(minimum);
    const columns=model?.data?.columns;
    const names=columns?.names??report?.column_names??[];
    const imported=columns?.session && columns.session===state.market_as_of?.slice(0,10)?columns.imported:{};
    const qualified=(row:NonNullable<typeof report>["rows"][number])=>filters.filter(k=>row[k]===true).length>=minimum;
    const mark = (value?:boolean) => value == null ? "Unavailable" : value ? "✓ Pass" : "✕ Fail";
    return <>
      <h3 className="font-semibold">{cloud?"Live query matches":"Original Screener query matches"}</h3>
      {query && <details><summary>Query used in this run</summary><pre className="whitespace-pre-wrap">{query}</pre></details>}
      {state.error && <p role="alert">{state.error}</p>}
      {report ? <>
        {cloud ? <p>{report.rows.length} confirmed query matches across {num(report.universe_size)} listings · {num(report.unknown)} awaiting evidence · Cloud scan {date(report.at)} IST</p>
          : <p>{report.rows.length} of {num(report.total)} original matches captured · {report.source ?? "Screener.in"} · {date(report.at)} IST</p>}
        <p>{report.rows.filter(qualified).length} qualified under {label}{state.market_as_of && <> · Candle cutoff {date(state.market_as_of)} IST</>}</p>
        {report.error && <p role="alert">{report.error}</p>}
        <ScorecardTable columns={["Company","Symbol","Universe","Liquidity","Support touches","Rebound","Discovery price",label,...names]} headerContent={chooser?{[label]:chooser}:undefined}
          rows={report.rows.map(row=>{
            const values = filters.map(key=>row[key]);
            const key=(row.exchange??"NSE")+":"+row.symbol;
            const count=values.filter(v=>v===true).length;
            const possible=count+values.filter(v=>v==null).length;
            return {key,cells:[row.name,<TradingViewSymbolLink key="stock" symbol={row.symbol.includes(":")?row.symbol:(row.exchange??"NSE")+":"+row.symbol}/>,...values.map(mark),
              (qualified(row)?"✓ Qualified":possible<minimum?"✕ Excluded":"Unconfirmed")+" ("+count+"/5)",
              ...names.map(name=>{const native=imported?.[key]?.[name];const v=native??row.columns?.[name];
                const source=native!=null?"Screener CSV":name.startsWith("Volume")||name.includes("DMA")?(row.exchange??"NSE")+" listing · Upstox":"Issuer or exchange observation";
                return <span key={name} title={v==null?"No verified value for this company and session":source}>{num(v)}</span>;})]};
          })}
          empty={cloud ? (report.unknown ? "No confirmed matches yet. Coverage is partial." : "No stocks matched this query.") : report.complete?"Screener returned zero matches for this query.":"Original query results unavailable."}/>
      </> : cloud ? <p>Current query results unavailable.</p> : <p>This run did not capture the original Screener result list. Run the query again to populate the comparison.</p>}
    </>;
  }
  if (stage==="screen") return <><p>{setups.length} discovered · {num(scan?.current_candles)} / {num(scan?.patterns)} support patterns with a current candle</p>
    {scan?.query_passed!=null && <p>{num(scan.query_passed)} passed the query · {num(scan.query_excluded)} excluded · {num(scan.query_missing)} with missing query data</p>}
    {query && <details><summary className="cursor-pointer text-indigo-700">Query used in this run</summary><pre className="mt-2 whitespace-pre-wrap">{query}</pre></details>}
    <Table headers={["Stock","Discovered (IST)","Discovery ₹","Support ₹","Range high ₹","Setup"]} empty="No setups recorded." rows={setups.map(([k,v])=>({key:k,cells:[<TradingViewSymbolLink key="stock" symbol={k}/>,date(v.discovered),num(v.discovery),num(v.low),num(v.high),v.invalid?"Support broken":"In range at discovery"]}))}/></>;
  if (stage==="score") {
    const report=state.original_results, minimum=report?.minimum??output.settings?.discovery?.minimum??5;
    const passed=report?.rows.filter(r=>filterKeys.filter(k=>r[k]===true).length>=minimum).length??0;
    return <>{state.scored_at && report && <p className="text-sm text-slate-700">{report.rows.length} query matches · {passed} qualified under <strong>{thresholdName(minimum)}</strong> · {(state.rows??[]).filter(r=>r.score!=null).length} scored.
      {state.scorecard_inputs && <> Stage 3 used the runs selected in Inputs.</>}</p>}
      <Table headers={["Stock","Score /100",...Object.values(labels),"Decision"]} empty={state.scored_at ? (output.settings?.inputs?.length===0 ? "Scorecard ran with the screen input disabled." : "Scorecard ran. No eligible listings among the confirmed results.") : "No scored listings recorded."}
    rows={(state.rows??[]).map(r=>({key:r.symbol,cells:[<TradingViewSymbolLink key="stock" symbol={r.symbol}/>,num(r.score),...Object.keys(labels).map(k=>num(r.points?.[k])),r.reason]}))}/></>;
  }
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
