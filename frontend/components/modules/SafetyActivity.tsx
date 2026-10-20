'use client';
import {useEffect,useState} from 'react';
import {apiService} from '@/services/api';
type Activity={read_only:boolean;events:{id:number;action:string;at:string;status:string}[];sources:{name:string;state:string;items:{id:string;action:string;status:string}[]}[];notice:string};
export function SafetyActivity(){
 const [data,setData]=useState<Activity|null>(null),[error,setError]=useState<string|null>(null);
 useEffect(()=>{const controller=new AbortController();apiService.fetch<Activity>('/backend-api/me/modules/safety-activity',{cache:'no-store',signal:controller.signal}).then(setData).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Safety activity unavailable');});return()=>controller.abort();},[]);
 if(error)return <p role="alert">Safety activity unavailable: {error}. No live reconciliation result is inferred.</p>;
 if(!data)return <p role="status">Loading safety activity…</p>;
 return <section className="space-y-4 rounded-xl border p-5"><h2 className="text-lg font-semibold">Safety activity</h2><p className="text-sm text-muted-foreground">{data.notice}</p>{data.sources.map(source=><div key={source.name}><h3 className="font-medium">Accepted order records</h3><p>Source: {source.state==='restricted'?'Restricted by existing runtime role':source.state}</p>{source.items.map(item=><p key={item.id}>{item.id}: {item.action} · {item.status}</p>)}{source.state==='checked'&&source.items.length===0&&<p>No unresolved accepted intents in this recorded source.</p>}</div>)}<ul className="space-y-2">{data.events.map(event=><li key={event.id} className="rounded border p-3">{event.action} · {event.status}<time className="ml-2 text-sm" dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></li>)}</ul>{data.events.length===0&&<p>No recorded account order or module activity.</p>}</section>;
}
