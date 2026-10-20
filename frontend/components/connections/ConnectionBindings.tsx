'use client';
import {useEffect,useRef,useState} from 'react';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';
import {useSession} from 'next-auth/react';

type Binding={id:string;provider:string;app_ownership_mode:'user_owned'|'platform_managed';account_label:string|null;version:number;status:string;token_expires_at:string|null;encryption_key_version:number|null;readiness:{ready_for_adapter:boolean;reason:string|null;platform_approval_verified:boolean|null;module_access_granted:false;financial_execution_granted:false}};
type Metadata={schema_version:1;owner_id:number;connections:Binding[]};
export function ConnectionBindings(){
 const {user}=useAuth();const {data:session,status}=useSession();const owner=status==='authenticated'?user?.id:undefined;const sessionGeneration=session?.generation;const generation=useRef(0);
 const [retry,setRetry]=useState(0);const [state,setState]=useState<{owner:number;generation?:string;data?:Metadata;error?:string}>();
 useEffect(()=>{
  const ticket=++generation.current;const controller=new AbortController();
  if(owner!==undefined){
   setState({owner,generation:sessionGeneration});
   void apiService.fetch<Metadata>('/backend-api/me/connections',{signal:controller.signal,cache:'no-store',timeoutMs:8000}).then(data=>{
    if(data.schema_version!==1||data.owner_id!==owner||!Array.isArray(data.connections)||data.connections.length>50||data.connections.some(row=>!row||typeof row.id!=='string'||!['user_owned','platform_managed'].includes(row.app_ownership_mode)||typeof row.status!=='string'||typeof row.version!=='number'||!row.readiness||typeof row.readiness.ready_for_adapter!=='boolean'||row.readiness.module_access_granted!==false||row.readiness.financial_execution_granted!==false))throw new Error('Invalid private metadata');
    if(!controller.signal.aborted&&generation.current===ticket)setState({owner,generation:sessionGeneration,data});
   }).catch(()=>{if(!controller.signal.aborted&&generation.current===ticket)setState({owner,generation:sessionGeneration,error:'Connection metadata is unavailable. No provider action was performed.'});});
  }
  return()=>{controller.abort();generation.current++;};
 },[owner,sessionGeneration,retry]);
 const visible=state?.owner===owner&&state?.generation===sessionGeneration?state:undefined;
 return <section aria-labelledby="binding-heading" className="space-y-3 rounded-xl border p-5 min-w-0">
  <h2 id="binding-heading" className="font-semibold">Private connection bindings</h2>
  <p className="text-sm text-muted-foreground">Use your own Kite app or an approved CredX-managed app. Each account retains its own authorization. App secrets and tokens are never displayed here.</p>
  {owner===undefined?<p>Sign in to view your connections.</p>:!visible?.data&&!visible?.error?<p role="status">Loading private connection metadata…</p>:null}
  {visible?.error&&<p role="alert">{visible.error}</p>}
  {visible?.data?.connections.length===0&&<p>No connection is stored for your account. Authorization setup is pending the next stage.</p>}
  {visible?.data?.connections.map(row=><article key={row.id} className="space-y-1 rounded-lg border p-4 break-words" data-connection-mode={row.app_ownership_mode}>
   <h3 className="font-medium">{row.app_ownership_mode==='user_owned'?'Your Kite app':'CredX-managed Kite app'}</h3>
   <p>Account {row.account_label??'awaiting verification'} · {row.status.replaceAll('_',' ')}</p>
   <p>Connection version {row.version} · Encryption key version {row.encryption_key_version??'awaiting verification'}</p>
   <p>{row.readiness.ready_for_adapter?'Credential binding verified.':'Credential binding unavailable: '+(row.readiness.reason??'authorization required').replaceAll('_',' ').toLowerCase()+'.'}</p>
   {row.app_ownership_mode==='platform_managed'&&<p>Provider approval: {row.readiness.platform_approval_verified?'verified':'pending; activation blocked'}</p>}
   <p className="text-sm text-muted-foreground">Storage readiness grants no module access or financial execution. Authorization and connection management are pending the next stage.</p>
  </article>)}
  {owner!==undefined&&<button type="button" className="underline" onClick={()=>setRetry(v=>v+1)}>Refresh connection metadata</button>}
 </section>;
}
