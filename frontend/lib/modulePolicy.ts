/** Typed server presentation contract; no client module registry or grants. */
export type ModuleDecision = {allowed:boolean; reasons:string[]};
export type ModuleState = {
  module_id:string; label:string; category:string;
  selection:{enabled:boolean;version:number;schedules_paused:boolean;config:{schema_version:1}};
  availability:{available:boolean;reason:string|null};
  connection:{kind:string;state:string}; entitlement:{jurisdiction:string;plan:string};
  execution:{capable:boolean;action_confirmed:boolean}; requires:string[];
  capabilities:Record<string,ModuleDecision>;
};
export type ModuleSurface={path:string;label?:string;module_ids:string[];capability:string;query_params?:Record<string,string>};
export type ModuleCollection={schema_version:1;owner_id:number;version:number;modules:ModuleState[];
  presentation:{schema_version:1;surfaces:ModuleSurface[];api_rules:ModuleSurface[];core_paths:string[];
    preferences_path:string;connections_path:string;safety_activity_path:string}};
export function validCollection(value:unknown,owner:number):value is ModuleCollection {
  const x=value as ModuleCollection;
  if(!x||x.schema_version!==1||x.owner_id!==owner||!Number.isInteger(x.version)||x.version<0||!Array.isArray(x.modules)||x.modules.length!==10)return false;
  const ids=new Set(x.modules.map(m=>m?.module_id));
  if(ids.size!==10||!x.modules.every(m=>typeof m.module_id==='string'&&typeof m.label==='string'&&typeof m.category==='string'&&
    typeof m.selection?.enabled==='boolean'&&Number.isInteger(m.selection.version)&&m.selection.version>=0&&m.selection.version<=x.version&&typeof m.selection.schedules_paused==='boolean'&&m.selection.config?.schema_version===1&&
    typeof m.availability?.available==='boolean'&&typeof m.connection?.kind==='string'&&['ready','missing','unknown','not_required'].includes(m.connection.state)&&
    !!m.entitlement&&typeof m.execution?.capable==='boolean'&&typeof m.execution.action_confirmed==='boolean'&&Array.isArray(m.requires)&&
    !!m.capabilities&&Object.values(m.capabilities).every(c=>typeof c?.allowed==='boolean'&&Array.isArray(c.reasons)&&c.reasons.every(r=>typeof r==='string'))))return false;
  const p=x.presentation;
  const surface=(s:ModuleSurface)=>!!s&&typeof s.path==='string'&&s.path.startsWith('/')&&!s.path.startsWith('//')&&Array.isArray(s.module_ids)&&s.module_ids.length>0&&s.module_ids.every(id=>ids.has(id))&&s.capability==='view';
  return p?.schema_version===1&&Array.isArray(p.surfaces)&&p.surfaces.every(surface)&&Array.isArray(p.api_rules)&&p.api_rules.every(surface)&&
    Array.isArray(p.core_paths)&&p.core_paths.every(path=>typeof path==='string'&&path.startsWith('/console/'))&&p.preferences_path==='/console/profile/preferences'&&
    typeof p.connections_path==='string'&&p.connections_path.startsWith('/console/profile/')&&p.safety_activity_path==='/console/profile/activity';
}
export function pathMatch(path:string,prefix:string){return path===prefix||path.startsWith(prefix+'/');}
export function surfaceFor(manifest:ModuleCollection|null,path:string,api=false){
  return (api?manifest?.presentation.api_rules:manifest?.presentation.surfaces)?.filter(s=>pathMatch(path,s.path)).sort((a,b)=>b.path.length-a.path.length)[0];
}
export function visibleModule(manifest:ModuleCollection|null,id:string){return manifest?.modules.some(m=>m.module_id===id&&m.selection.enabled&&m.availability.available)??false;}
export function allowedModule(manifest:ModuleCollection|null,id:string,capability='view'){return manifest?.modules.some(m=>m.module_id===id&&m.selection.enabled&&m.availability.available&&m.capabilities[capability]?.allowed===true)??false;}
export function surfaceVisible(manifest:ModuleCollection|null,path:string){
  const surface=surfaceFor(manifest,path);
  return surface?surface.module_ids.some(id=>visibleModule(manifest,id)):!!manifest&&(path==='/console/dashboard'||manifest.presentation.core_paths.some(p=>pathMatch(path,p)));
}
export function surfaceAllowed(manifest:ModuleCollection|null,path:string){const s=surfaceFor(manifest,path);return s?s.module_ids.some(id=>allowedModule(manifest,id,s.capability)):surfaceVisible(manifest,path);}
