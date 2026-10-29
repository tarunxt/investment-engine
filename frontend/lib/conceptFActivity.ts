export type ActivityMarket='india'|'indmoney_us';
export type ActivityItem={key:string;kind:'research'|'legacy_research'|'import'|'source'|'review';portfolio:ActivityMarket|null;resource_id:string;recorded_at:string;time_basis:'created'|'accepted'|'captured'|'last_saved';state:string;unresolved:boolean;source_version:number|string|null;historical_only:true;record_hash:string};
export type ActivitySource={name:'order_reviews'|'module_history'|'research_history'|'source_history';portfolio:ActivityMarket|null;status:'available'|'not_selected'|'restricted';has_more:boolean;rejected:number};
export type ActivityHistory={observedAt:string;items:ActivityItem[];sources:ActivitySource[];hasMore:boolean};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const market=(value:unknown):value is ActivityMarket|null=>value===null||value==='india'||value==='indmoney_us';
const date=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function admitActivity(value:unknown,owner:number,portfolio:ActivityMarket|null):ActivityHistory{
 const data=object(value);if(!data||data.schema_version!==1||data.owner_id!==owner||data.portfolio!==portfolio||data.simulation_only!==true||data.read_only!==true||data.orders_authorized!==false||data.complete_account_history!==false||data.live_reconciliation_verified!==false||!date(data.observed_at)||typeof data.has_more!=='boolean'||!Array.isArray(data.items)||data.items.length>100||!Array.isArray(data.sources)||data.sources.length>7)throw new Error('Exact owned read-only activity scope required');
 const items=data.items.map(raw=>{const row=object(raw);if(!row||!['research','legacy_research','import','source','review'].includes(String(row.kind))||!market(row.portfolio)||portfolio!==null&&row.portfolio!==portfolio||typeof row.resource_id!=='string'||!date(row.recorded_at)||!['created','accepted','captured','last_saved'].includes(String(row.time_basis))||typeof row.state!=='string'||!/^[a-z_]{1,32}$/.test(row.state)||typeof row.unresolved!=='boolean'||row.historical_only!==true||!hash(row.record_hash)||!(row.source_version===null||hash(row.source_version)||typeof row.source_version==='number'&&Number.isSafeInteger(row.source_version)&&row.source_version>=0))throw new Error('Supported owned metadata required');
 if(['research','legacy_research','import'].includes(String(row.kind))?(!/^[1-9]\d{0,12}$/.test(row.resource_id)||row.portfolio===null):!uuid(row.resource_id))throw new Error('Exact activity resource identity required');
 if(row.kind==='source'&&row.portfolio!=='india'||row.kind==='import'&&row.portfolio!=='indmoney_us'||row.kind!=='review'&&row.unresolved)throw new Error('Activity source family mismatch');
 if(row.key!==`${row.kind}:${row.portfolio??'core'}:${row.resource_id}`)throw new Error('Activity namespace mismatch');
 return {key:row.key,kind:row.kind,portfolio:row.portfolio,resource_id:row.resource_id,recorded_at:row.recorded_at,time_basis:row.time_basis,state:row.state,unresolved:row.unresolved,source_version:row.source_version,historical_only:true,record_hash:row.record_hash} as ActivityItem;});
 if(new Set(items.map(row=>row.key)).size!==items.length)throw new Error('Ambiguous activity identity');
 const sources=data.sources.map(raw=>{const row=object(raw);if(!row||!['order_reviews','module_history','research_history','source_history'].includes(String(row.name))||!market(row.portfolio)||!['available','not_selected','restricted'].includes(String(row.status))||typeof row.has_more!=='boolean'||typeof row.rejected!=='number'||!Number.isSafeInteger(row.rejected)||row.rejected<0||row.rejected>100||row.name==='order_reviews'&&row.portfolio!==null||row.name!=='order_reviews'&&row.portfolio===null||portfolio!==null&&row.portfolio!==null&&row.portfolio!==portfolio)throw new Error('Activity coverage metadata required');return {name:row.name,portfolio:row.portfolio,status:row.status,has_more:row.has_more,rejected:row.rejected} as ActivitySource;});
 if(new Set(sources.map(row=>row.name+':'+row.portfolio)).size!==sources.length)throw new Error('Ambiguous source coverage');
 return {observedAt:data.observed_at as string,items,sources,hasMore:data.has_more};
}
export function activityHref(row:ActivityItem){const root=row.portfolio==='india'?'/console/zerodha':'/console/indmoney-us';switch(row.kind){case 'research':return root+'/research?research='+row.resource_id;case 'legacy_research':return '/console/auto-rebalance-runs/'+(row.portfolio==='india'?'zerodha':'indmoneyUs')+'/'+row.resource_id;case 'import':case 'source':return root+'/portfolio?view=holdings&snapshot='+row.resource_id+(typeof row.source_version==='string'?'&snapshotVersion='+row.source_version:'');case 'review':return '/console/profile/activity?intent='+row.resource_id+'#order-review-heading';}}
export function activityGroup(row:ActivityItem){return row.kind==='review'?'reviews':['import','source'].includes(row.kind)?'imports':'research';}
export function filteredActivity(data:ActivityHistory,group:string,portfolio:string,state:string,days:number|null){const cutoff=days===null?null:Date.parse(data.observedAt)-days*86400000;return data.items.filter(row=>(group==='all'||activityGroup(row)===group)&&(portfolio==='all'||row.portfolio===portfolio)&&(state==='all'||row.state===state)&&(cutoff===null||Date.parse(row.recorded_at)>=cutoff));}
export function selectedActivity(data:ActivityHistory|null,key:string|null,pinned:string|null){return data&&pinned?data.items.find(row=>row.key===key&&row.record_hash===pinned)??null:null;}

/** Local paging preserves every admitted returned record; it is not a full-account claim. */
export function activityWindow(items:ActivityItem[],requested:number){
 const size=4,pages=Math.max(1,Math.ceil(items.length/size));
 const page=Math.min(pages-1,Number.isSafeInteger(requested)&&requested>=0?requested:0);
 return {page,pages,start:page*size,items:items.slice(page*size,(page+1)*size),total:items.length};
}
