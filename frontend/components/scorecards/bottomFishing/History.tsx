"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {apiPath,date,route,type Stage} from "./model";
import {Status, scorecardButton} from "../ScorecardPresentation";
import {Table} from "./StageOutput";
import type {Model} from "./useBottomFishing";

type Item={id:number; mode:string; at?:string; status:string; candidates:number; scored:number; entries:number};
type Page={items:Item[];next_before?:number};
export function History({stage,client,scorecards}:{stage:Stage;client:Model["client"];scorecards:boolean}) {
  const [cursor,setCursor]=useState<number|null>(null);
  const [data,setData]=useState<Page|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{let current=true;
    setData(null);setError("");
    client.get<Page>(apiPath()+"/history"+(cursor?"?before="+cursor:"")).then(result=>{if(current)setData(result);}).catch(err=>{if(current)setError(String(err));});
    return ()=>{current=false;};
  },[client,cursor]);
  if(error) return <p role="alert">{error}</p>;
  if(!data) return <p>Loading history…</p>;
  return <><Table headers={scorecards?["Saved scorecard","Mode","Status","Listings scored"]:["Saved run","Mode","Status","Discovered","Scored","Sized entries"]}
    rows={data.items.map(item=>({key:String(item.id),cells:[
      <Link className="text-indigo-700 underline" href={route+"/"+stage+"?record="+item.id} key={item.id}>{date(item.at)} IST · #{item.id}</Link>,
      item.mode,<Status key="status" value={item.status}/>,...(scorecards?[item.scored]:[item.candidates,item.scored,item.entries])
    ]}))} empty="No saved runs yet."/>
    <div className="flex gap-4">{cursor && <button className={scorecardButton} onClick={()=>setCursor(null)}>Latest runs</button>}
      {data.next_before && <button className={scorecardButton} onClick={()=>setCursor(data.next_before??null)}>Older runs</button>}</div></>;
}
