'use client';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {apiService} from '@/services/api';
import {allowedModule,moduleScopeKey} from '@/lib/modulePolicy';
import {admitJournalPortfolio} from '@/lib/conceptFJournalSource';
import {portfolioView,type PortfolioView} from '@/lib/conceptFPortfolio';
import {ConceptFDashboard,type Props} from './ConceptFDashboard';
/** UAT2 India cards never use the retained generic fixture from legacy summary. */
export function ConceptFJournalDashboard({owner,...props}:Props&{owner:number}){
 const [revision,setRevision]=useState(0);
 const enabled=allowedModule(props.manifest,'zerodha_rebalance'),scope=moduleScopeKey(props.manifest);
 const requestScope=useMemo(()=>({owner,enabled,scope,revision}),[owner,enabled,scope,revision]);
 const [result,setResult]=useState<{scope:typeof requestScope;view:PortfolioView|null;error:boolean}|null>(null);
 const active=useRef<typeof requestScope|null>(null),current=result?.scope===requestScope;
 const source=current?result.view:null,failed=enabled&&current&&result.error,reading=enabled&&!current;
 useLayoutEffect(()=>{active.current=requestScope;return()=>{active.current=null;};},[requestScope]);
 useEffect(()=>{const abort=new AbortController();if(!enabled)return()=>abort.abort();
  void apiService.fetch('/backend-api/uat2/simulation/journal-portfolio',{signal:abort.signal,cache:'no-store',timeoutMs:8000}).then(value=>{const admitted=admitJournalPortfolio(value,owner),view=portfolioView(admitted.latest,'india');if(!view)throw new Error('Current owned journal required');if(!abort.signal.aborted&&active.current===requestScope)setResult({scope:requestScope,view,error:false});}).catch(()=>{if(!abort.signal.aborted&&active.current===requestScope)setResult({scope:requestScope,view:null,error:true});});return()=>abort.abort();
 },[owner,enabled,requestScope]);
 const snapshot=enabled&&source?{captured_at:source.capturedAt!,holdings_count:source.holdings.length,holdings_market_value:source.total,source:source.source,source_receipt_id:source.id,top_holdings:source.holdings.slice(0,4).map(row=>({symbol:row.symbol,company_name:row.name,weight_percent:row.weight}))}:null;
 const summary={...(props.summary??{}),zerodha:enabled?{snapshot}:null};
 return <><ConceptFDashboard {...props} summary={summary} error={props.error||failed} busy={props.busy||reading} onRefresh={()=>{setRevision(value=>value+1);props.onRefresh();}}/>{source&&enabled&&<p className="mt-5 break-words text-xs text-muted-foreground">India values use owned acquisition {source.id}, the same source contract as Research. Captured fake prices only; no live broker completeness, cost basis or available cash is inferred.</p>}</>;
}
