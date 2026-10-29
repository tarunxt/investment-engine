export type WorkspaceDisplay={schema:1;owner:number;masked:boolean;density:'comfortable'|'compact';module:string|null};
export const displayKey=(owner:number)=>`credx:workspace-display:v1:${owner}`;
export const defaultDisplay=(owner:number):WorkspaceDisplay=>({schema:1,owner,masked:true,density:'comfortable',module:null});
export function readDisplay(raw:string|null,owner:number):WorkspaceDisplay {
 try{const x=JSON.parse(raw??'null');if(x?.schema===1&&x.owner===owner&&typeof x.masked==='boolean'&&['comfortable','compact'].includes(x.density)&&(x.module===null||typeof x.module==='string'&&/^[a-z0-9_]{1,64}$/.test(x.module)))return {schema:1,owner,masked:x.masked,density:x.density,module:x.module};}catch{}
 return defaultDisplay(owner);
}
