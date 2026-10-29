'use client';
import {useState} from 'react';
import dynamic from 'next/dynamic';
import {usePathname} from 'next/navigation';
import {useAuth,type User} from '@/hooks/useAuth';
import {useModules} from '@/providers/ModuleContext';
import {useLegacyNavigationMetadata} from './useLegacyNavigationMetadata';
import {ConceptFDetailPanel} from './ConceptFDetailPanel';
const LegacyEditor=dynamic(()=>import('@/app/console/_components/SidebarNavigation').then(module=>module.SidebarNavigation),{ssr:false,loading:()=> <p role="status">Loading saved navigation controls…</p>});
export function ConceptFNavigationEditor({user}:{user:User|null}){
 const [open,setOpen]=useState(false),auth=useAuth(),{manifest}=useModules(),path=usePathname();
 const metadata=useLegacyNavigationMetadata(user?.id??null);
 const ready=!!user&&auth.user?.id===user.id&&manifest?.owner_id===user.id&&metadata.available;
 return <><button id="open-navigation-customization" type="button" className="concept-f-secondary" disabled={!ready} onClick={()=>setOpen(true)}>Customize navigation</button>{!ready&&<p className="text-xs">Navigation editing requires verified account storage and module policy.</p>}{open&&ready&&<ConceptFDetailPanel title="Advanced navigation preferences" returnFocusId="open-navigation-customization" onClose={()=>setOpen(false)}><p className="mb-4 text-sm">Existing account-scoped names and within-section ordering are retained. Recognized labels and module order apply to the selected Concept F navigation; its fixed safety/account structure stays visible. Names never change destinations, availability, permissions, schedules or orders. These browser choices survive same-account reloads and are cleared at logout/account boundaries by the existing privacy cleanup. Right-click an item for its name controls; reorder mode also supports keyboard dragging.</p><div className="h-[min(75vh,48rem)] overflow-hidden rounded-xl bg-sidebar py-4 text-sidebar-foreground"><LegacyEditor pathname={path} user={user} userId={user.id} onNavigate={()=>setOpen(false)} onLogout={auth.logout}/></div></ConceptFDetailPanel>}</>;
}
