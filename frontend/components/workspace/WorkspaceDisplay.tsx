'use client';
import {createContext,useContext,useState,useSyncExternalStore,type ReactNode} from 'react';
import {defaultDisplay,displayKey,readDisplay,type WorkspaceDisplay} from '@/lib/workspaceDisplay';
type Context={value:WorkspaceDisplay;save:(change:Partial<Pick<WorkspaceDisplay,'masked'|'density'|'module'>>)=>void;error:boolean};
const DisplayContext=createContext<Context|null>(null);
const subscribe=(notify:()=>void)=>{window.addEventListener('storage',notify);window.addEventListener('credx:workspace-display',notify);return()=>{window.removeEventListener('storage',notify);window.removeEventListener('credx:workspace-display',notify);};};
export const useWorkspaceDisplay=()=>useContext(DisplayContext);
export function WorkspaceDisplayProvider({owner,children}:{owner:number|null;children:ReactNode}){return owner&&Number.isInteger(owner)?<OwnedDisplay key={owner} owner={owner}>{children}</OwnedDisplay>:<>{children}</>;}
function OwnedDisplay({owner,children}:{owner:number;children:ReactNode}){
 const [error,setError]=useState(false),key=displayKey(owner);
 const raw=useSyncExternalStore(subscribe,()=>{try{return localStorage.getItem(key);}catch{return null;}},()=>null);
 const value=readDisplay(raw,owner);
 function save(change:Partial<Pick<WorkspaceDisplay,'masked'|'density'|'module'>>){
  try{const current=readDisplay(localStorage.getItem(key),owner);const next=readDisplay(JSON.stringify({...current,...change}),owner);localStorage.setItem(key,JSON.stringify(next));setError(false);window.dispatchEvent(new Event('credx:workspace-display'));}catch{setError(true);}
 }
 return <DisplayContext value={{value,save,error}}><div data-density={value.density}>{children}</div></DisplayContext>;
}
