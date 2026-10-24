import {headers} from 'next/headers';
import {createBackendSessionContext,fetchBackendJsonWithSession} from '@/app/api/bullpen-ai/_lib/serverBackendSession';
/** Current backend identity, never a client flag or a role grant. */
export async function currentAdministrator(){
 try{
  const session=await createBackendSessionContext({headers:await headers()});
  const user=await fetchBackendJsonWithSession<{role:string;is_active:boolean}>(session,'/auth/me');
  return user.role==='admin'&&user.is_active===true;
 }catch{return false;}
}
export async function currentCostAdministrator(){
 return (await costAdministratorOwner())!==null;
}
export async function costAdministratorOwner(){
 try{
  const session=await createBackendSessionContext({headers:await headers()});
  const result=await fetchBackendJsonWithSession<{allowed:boolean;scope:string;owner_id:number}>(session,'/api/admin/cost-drivers/access');
  return result.allowed===true&&result.scope==='cost_dashboard'&&Number.isInteger(result.owner_id)?result.owner_id:null;
 }catch{return null;}
}
