'use client';

import Link from 'next/link';
import {Clock3, Compass, LayoutGrid, WalletMinimal} from 'lucide-react';
import {useModules} from '@/providers/ModuleContext';
import {allowedModule} from '@/lib/modulePolicy';

/** Navigation only: never acquires a source or starts a financial operation. */
export function ConceptFMobileNavigation({pathname,onMore,expanded=false}:{pathname:string;onMore:(trigger?:HTMLButtonElement)=>void;expanded?:boolean}) {
 const {manifest}=useModules();
 const root=allowedModule(manifest,'zerodha_rebalance')?'/console/zerodha':allowedModule(manifest,'indmoney_us')?'/console/indmoney-us':null;
 const links=[{href:'/console/dashboard',label:'Home',Icon:LayoutGrid},...(root?[{href:root+'/portfolio',label:'Portfolio',Icon:WalletMinimal}]:[]),{href:'/console/profile/activity',label:'Activity',Icon:Clock3}];
 return <nav aria-label="Mobile workspace" className="concept-f-mobile-navigation lg:hidden">
  {links.map(({href,label,Icon})=><Link key={href} href={href} prefetch={false} aria-current={pathname===href?'page':undefined}><Icon aria-hidden="true" size={20}/><span>{label}</span></Link>)}
  <button type="button" onClick={event=>onMore(event.currentTarget)} aria-controls="console-sidebar" aria-expanded={expanded} aria-label="More workspace navigation"><Compass aria-hidden="true" size={20}/><span>More</span></button>
 </nav>;
}

export function ConceptFHeader({pathname,researchHistory=false,planCalculation=false,diagnosticHistory=false,usResearchSummary=false}:{pathname:string;researchHistory?:boolean;planCalculation?:boolean;diagnosticHistory?:boolean;usResearchSummary?:boolean}) {
 const section=usResearchSummary?'INDmoney US':diagnosticHistory?'Activity':planCalculation||/^\/console\/(zerodha|indmoney-us)\/plans$/.test(pathname)?'Plans':researchHistory?'Research':pathname==='/console/profile'?'Profile':pathname==='/console/profile/activity'?'Activity':pathname==='/console/profile/get-started'?'Overview':['/console/zerodha/research','/console/indmoney-us/research'].some(root=>pathname===root||pathname.startsWith(root+'/'))?'Research':pathname.startsWith('/console/zerodha')?'Zerodha':pathname.startsWith('/console/indmoney-us')?'INDmoney US':pathname.startsWith('/console/profile')?'Profile':pathname==='/console/dashboard'?'Overview':'Workspace';
 return <div className="concept-f-desktop-header hidden lg:flex"><span>Workspace / {section}</span><div className="flex items-center gap-3"><span className="concept-f-safety-label">Owner only</span><span className="concept-f-safety-label">Simulation</span></div></div>;
}
