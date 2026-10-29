import { allowedModule,pathMatch,type ModuleCollection } from './modulePolicy';
let installed=false;
let current:ModuleCollection|null=null;
let epoch=new AbortController();
export function installModulePolicy(manifest:ModuleCollection|null){
  installed=true;epoch.abort();epoch=new AbortController();current=manifest;
}
export function clearModulePolicy(){installed=true;current=null;epoch.abort();epoch=new AbortController();}
export function moduleRequestSignal(url:string,caller?:AbortSignal|null){
  if(!installed||typeof window==='undefined')return caller??undefined;
  const parsed=new URL(url,window.location.origin);
  const path=parsed.pathname.replace(/^\/(backend-api|api)(?=\/)/,'');
  if(!current&&!['/auth','/me','/account','/profile','/users','/jobs','/runs','/mails','/uat2','/api-usage','/cost-drivers','/health'].some(p=>path===p||path.startsWith(p+'/')))throw new DOMException('Module policy unavailable','AbortError');
  const rule=current?.presentation.api_rules.filter(rule=>pathMatch(path,rule.path)&&Object.entries(rule.query_params??{}).every(([key,value])=>parsed.searchParams.get(key)===value)).sort((a,b)=>b.path.length-a.path.length)[0];
  // These market-scoped optional surfaces must not inherit the broad core
  // /uat2 fixture fallback when a manifest is missing or predates the route.
  if(/^\/uat2\/simulation\/(?:buy-threshold|recommendation-history)\/(?:india|indmoney_us)$/.test(path)&&!rule)throw new DOMException('Market module policy unavailable','AbortError');
  // Core account/safety reads are independent. Optional rules are server-owned.
  if(rule&&!rule.module_ids.some(id=>allowedModule(current,id,rule.capability))){
    throw new DOMException('Module unavailable or disabled. Open Preferences.','AbortError');
  }
  return (rule||['/dashboard','/jobs','/runs','/mails/history','/api-usage'].some(p=>pathMatch(path,p)))?AbortSignal.any([epoch.signal,...(caller?[caller]:[])]):caller??undefined;
}
