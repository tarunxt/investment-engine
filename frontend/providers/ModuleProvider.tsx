'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import {ModulesContext} from './ModuleContext';
import {usePathname} from 'next/navigation';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';
import {validCollection,type ModuleCollection} from '@/lib/modulePolicy';
import {installModulePolicy,clearModulePolicy} from '@/lib/moduleRequests';
import {closePrivateWebSockets} from '@/services/privateSocketRegistry';
import {purgeBrowserPrivateModuleCaches} from '@/lib/privateDashboardCache';

type Scope={identity:string|null;epoch:number;floor:number};
type Mutation={scope:Scope;epoch:number};
export function ModuleProvider({children}:{children:React.ReactNode}){
 const {user}=useAuth();const {data:session,status}=useSession();const path=usePathname();
 const owner=status==='unauthenticated'?null:user?.id??null;
 const identity=owner===null?null:`${owner}:${session?.generation??'bootstrap'}`;
 // Each committed identity gets a distinct lifetime, including A -> B -> A.
 // Render only derives the boundary; refs are installed during layout commit.
 const boundary=useMemo<Scope>(()=>({identity,epoch:0,floor:0}),[identity]);
 const scope=useRef<Scope>(boundary);
 const [state,setState]=useState<{scope:Scope|null;manifest:ModuleCollection|null;loading:boolean;error:string|null}>({scope:null,manifest:null,loading:true,error:null});
 const request=useRef<AbortController|null>(null);const sequence=useRef(0);const liveOwner=useRef(owner);
 const current=state.scope===boundary?state.manifest:null;const latest=useRef<ModuleCollection|null>(null);
 const channel=useRef<BroadcastChannel|null>(null);const saving=useRef<Mutation|null>(null);
 const replace=useCallback((data:ModuleCollection|null,error:string|null=null)=>{
   const active=scope.current;
   if(data&&data.version<active.floor){
     data=null;error='A newer module preference version is known. Reload preferences.';
   }
   if(data)active.floor=Math.max(active.floor,data.version);
   const changed=!data||JSON.stringify(latest.current)!==JSON.stringify(data);
   if(changed){installModulePolicy(data);closePrivateWebSockets();purgeBrowserPrivateModuleCaches(liveOwner.current);}
   latest.current=data;setState({scope:active,manifest:data,loading:false,error});
 },[]);
 const refresh=useCallback(async()=>{
  if(saving.current)return;
  request.current?.abort();const controller=new AbortController();request.current=controller;
  const ticket=++sequence.current;const origin=scope.current;const epoch=origin.epoch;const identity=liveOwner.current;
  if(!identity){clearModulePolicy();setState({scope:origin,manifest:null,loading:false,error:null});return;}
  const currentRequest=()=>!controller.signal.aborted&&ticket===sequence.current&&origin===scope.current&&epoch===origin.epoch;
  try{
   const data=await apiService.fetch<unknown>('/backend-api/me/modules',{signal:controller.signal,cache:'no-store',timeoutMs:8000});
   if(!currentRequest())return;
   if(!validCollection(data,identity))throw new Error('Module policy response is invalid. Optional features remain closed.');
   replace(data);
  }catch(e){if(currentRequest())replace(null,e instanceof Error?e.message:'Module preferences unavailable');}
 },[replace]);
 useLayoutEffect(()=>{
  scope.current=boundary;liveOwner.current=owner;latest.current=null;
  saving.current=null;clearModulePolicy();void refresh();
  const focus=()=>{void refresh();};const timer=window.setInterval(focus,15000);window.addEventListener('focus',focus);
  const bus=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('credx-module-invalidations');channel.current=bus;
  if(bus)bus.onmessage=(event)=>{
   if(scope.current!==boundary||event.data?.owner!==liveOwner.current)return;
   // A broadcast is only a revocation hint. Preserve its high-water version even
   // while closed, invalidate reads AND mutations, then fetch authoritative policy.
   if(Number.isInteger(event.data.version)&&event.data.version>=0)boundary.floor=Math.max(boundary.floor,event.data.version);
   boundary.epoch++;sequence.current++;request.current?.abort();saving.current=null;
   replace(null);void refresh();
  };
  return()=>{boundary.epoch++;request.current?.abort();saving.current=null;clearModulePolicy();window.clearInterval(timer);window.removeEventListener('focus',focus);bus?.close();};
 },[boundary,owner,refresh,replace]);
 useEffect(()=>{void refresh();},[path,refresh]);
 const save=useCallback(async(id:string,enabled:boolean)=>{
  const before=latest.current;const identity=liveOwner.current;const origin=scope.current;
  if(!before||before.owner_id!==identity||saving.current)throw new Error('Reload module preferences before saving.');
  request.current?.abort();sequence.current++;
  const mutation={scope:origin,epoch:origin.epoch};saving.current=mutation;
  const currentMutation=()=>saving.current===mutation&&scope.current===origin&&origin.epoch===mutation.epoch;
  try{
   const data=await apiService.fetch<unknown>('/backend-api/me/modules',{method:'PATCH',cache:'no-store',timeoutMs:8000,body:JSON.stringify({expected_version:before.version,updates:[{module_id:id,enabled,config:{schema_version:1}}]})});
   if(!currentMutation())throw new Error('Preferences changed in another tab or session. Reload preferences.');
   if(!validCollection(data,identity!))throw new Error('Invalid saved policy response. Reload preferences.');
   replace(data);channel.current?.postMessage({owner:identity,version:data.version});
  }catch(e){
   if(currentMutation()){saving.current=null;replace(null);await refresh();}
   throw e;
  }finally{if(saving.current===mutation)saving.current=null;}
 },[refresh,replace]);
 return <ModulesContext.Provider value={{manifest:current,loading:state.scope!==boundary||state.loading,error:state.scope===boundary?state.error:null,refresh,save}}>{children}</ModulesContext.Provider>;
}
