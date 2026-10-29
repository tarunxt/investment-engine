'use client';
import {useSyncExternalStore} from 'react';
import {privateLocalStorage,privateStorageOwnerMatches,isPrivateStorageEvent} from '@/lib/privateBrowserStorage';
import {SIDEBAR_SECTIONS} from '@/app/console/_components/sidebarNavigationConfig';
import {buildSidebarOrderStorageKey,collectEntrySectionIds,createDefaultSidebarOrder,orderNavigationSections,reconcileSidebarOrder} from '@/app/console/_components/sidebarNavigationUtils';
import {buildSidebarNamesStorageKey,buildSidebarChildOrderStorageKey,createDefaultChildOrder,readNavigationNameOverrides,readNavigationChildOrder} from '@/app/console/_components/sidebarNavigationPreferences';
import {navigationLabel,navigationRank} from '@/lib/conceptFNavigationNames';
const rootDefaults=createDefaultSidebarOrder(SIDEBAR_SECTIONS),entrySections=collectEntrySectionIds(SIDEBAR_SECTIONS),childDefaults=createDefaultChildOrder();
const events=['investment-engine:sidebar-order-updated','investment-engine:sidebar-names-updated','investment-engine:sidebar-child-order-updated'];
export function useLegacyNavigationMetadata(owner:number|null){
 const keys=[buildSidebarNamesStorageKey(owner),buildSidebarChildOrderStorageKey(owner),buildSidebarOrderStorageKey(owner)];
 const subscribe=(notify:()=>void)=>{
  const changed=(event:Event)=>{if(event instanceof StorageEvent?event.key===null||keys.some(key=>isPrivateStorageEvent(event,key)):event instanceof CustomEvent&&keys.includes(event.detail))notify();};
  window.addEventListener('storage',changed);events.forEach(event=>window.addEventListener(event,changed));
  return()=>{window.removeEventListener('storage',changed);events.forEach(event=>window.removeEventListener(event,changed));};
 };
 const snapshot=useSyncExternalStore(subscribe,()=>{try{return owner&&privateStorageOwnerMatches(owner)?JSON.stringify(keys.map(key=>privateLocalStorage.getItem(key))):'';}catch{return '!unavailable';}},()=>'');
 const available=!!snapshot&&snapshot!=='!unavailable';
 let names:Record<string,string>={},children=childDefaults,root=rootDefaults;
 if(available){
  names=readNavigationNameOverrides(keys[0]);children=readNavigationChildOrder(keys[1],childDefaults);
  try{root=reconcileSidebarOrder(JSON.parse(JSON.parse(snapshot)[2]??'{}'),rootDefaults,entrySections);}catch{/* Invalid order cannot add a route or section. */}
 }
 const leaves=orderNavigationSections(SIDEBAR_SECTIONS,root).flatMap(section=>section.entries.flatMap(entry=>entry.type==='group'?[...entry.children].sort((a,b)=>(children[entry.id]?.indexOf(a.id)??0)-(children[entry.id]?.indexOf(b.id)??0)):[entry]));
 const hrefs=leaves.map(leaf=>leaf.href);
 return {available,rank:(href:string)=>navigationRank(href,hrefs),label:(href:string,canonical:string)=>{const leaf=leaves.find(row=>row.href===href);return navigationLabel(leaf?names['item:'+leaf.id]:undefined,canonical);},group:(key:string,canonical:string)=>navigationLabel(names[key],canonical).label};
}
