'use client';
import {createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import {usePathname} from 'next/navigation';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';
import {validCollection,type ModuleCollection} from '@/lib/modulePolicy';
import {installModulePolicy,clearModulePolicy} from '@/lib/moduleRequests';
import {closePrivateWebSockets} from '@/services/privateSocketRegistry';
import {purgeBrowserPrivateDashboardCaches} from '@/lib/privateDashboardCache';

type Context={manifest:ModuleCollection|null;loading:boolean;error:string|null;refresh:()=>Promise<void>;save:(id:string,enabled:boolean)=>Promise<void>};
const ModulesContext=createContext<Context>({manifest:null,loading:true,error:null,refresh:async()=>{},save:async()=>{}});
export const useModules=()=>useContext(ModulesContext);
export function ModuleProvider({children}:{children:React.ReactNode}){
 const {user}=useAuth();const path=usePathname();const owner=user?.id??null;
 const [state,setState]=useState<{owner:number|null;manifest:ModuleCollection|null;loading:boolean;error:string|null}>({owner:null,manifest:null,loading:true,error:null});
 const request=useRef<AbortController|null>(null);const sequence=useRef(0);const liveOwner=useRef(owner);liveOwner.current=owner;
 const current=state.owner===owner?state.manifest:null;const latest=useRef(current);latest.current=current;
 const channel=useRef<BroadcastChannel|null>(null);const saving=useRef(false);
 const replace=useCallback((data:ModuleCollection|null,error:string|null=null)=>{
   if(data&&latest.current?.owner_id===data.owner_id&&data.version<latest.current.version)return;
   const changed=!data||JSON.stringify(latest.current)!==JSON.stringify(data);
   if(changed){installModulePolicy(data);closePrivateWebSockets();purgeBrowserPrivateDashboardCaches();}
   latest.current=data;setState({owner:liveOwner.current,manifest:data,loading:false,error});
 },[]);
 const refresh=useCallback(async()=>{
  if(saving.current)return;
  request.current?.abort();const controller=new AbortController();request.current=controller;const ticket=++sequence.current;const identity=liveOwner.current;
  if(!identity){clearModulePolicy();setState({owner:null,manifest:null,loading:false,error:null});return;}
  try{
   const data=await apiService.fetch<unknown>('/backend-api/me/modules',{signal:controller.signal,cache:'no-store',timeoutMs:8000});
   if(controller.signal.aborted||ticket!==sequence.current||identity!==liveOwner.current)return;
   if(!validCollection(data,identity))throw new Error('Module policy response is invalid. Optional features remain closed.');
   replace(data);
  }catch(e){if(!controller.signal.aborted&&ticket===sequence.current&&identity===liveOwner.current)replace(null,e instanceof Error?e.message:'Module preferences unavailable');}
 },[replace]);
 useEffect(()=>{
  clearModulePolicy();setState({owner,manifest:null,loading:true,error:null});void refresh();
  const focus=()=>{void refresh();};const timer=window.setInterval(focus,15000);window.addEventListener('focus',focus);
  channel.current=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('credx-module-invalidations');
  if(channel.current)channel.current.onmessage=(event)=>{if(event.data?.owner===liveOwner.current){replace(null);void refresh();}};
  return()=>{request.current?.abort();sequence.current++;clearModulePolicy();window.clearInterval(timer);window.removeEventListener('focus',focus);channel.current?.close();};
 },[owner,refresh,replace]);
 useEffect(()=>{void refresh();},[path,refresh]);
 const save=useCallback(async(id:string,enabled:boolean)=>{
  const before=latest.current;const identity=liveOwner.current;if(!before||before.owner_id!==identity)throw new Error('Reload module preferences before saving.');
  request.current?.abort();sequence.current++;saving.current=true;
  try{
   const data=await apiService.fetch<unknown>('/backend-api/me/modules',{method:'PATCH',cache:'no-store',timeoutMs:8000,body:JSON.stringify({expected_version:before.version,updates:[{module_id:id,enabled,config:{schema_version:1}}]})});
   if(identity!==liveOwner.current)return;
   if(!validCollection(data,identity!))throw new Error('Invalid saved policy response. Reload preferences.');
   replace(data);channel.current?.postMessage({owner:identity,version:data.version});
  }catch(e){saving.current=false;if(identity===liveOwner.current){replace(null);await refresh();}throw e;}finally{saving.current=false;}
 },[refresh,replace]);
 return <ModulesContext.Provider value={{manifest:current,loading:state.owner!==owner||state.loading,error:state.owner===owner?state.error:null,refresh,save}}>{children}</ModulesContext.Provider>;
}
