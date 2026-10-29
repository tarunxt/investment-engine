/** Admit bounded current-owner read models before formatting or releasing a file. */
export type PrivacyReceipt={id:string;owner_id:number;kind:'export'|'delete';state:string;created_at:string;expires_at:string;legal_approval:false;notice:string};
export type PrivacyHistory={owner_id:number;items:PrivacyReceipt[];has_more:boolean;real_deletion_enabled:false};
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Object required');return value as Record<string,unknown>;}
function instant(value:unknown):value is string {
 if(typeof value!=='string'||value.length>64)return false;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);if(!match)return false;
 const [,y,m,d,h,minute,second,,offsetHour,offsetMinute]=match;
 const calendar=new Date(0);calendar.setUTCFullYear(Number(y),Number(m)-1,Number(d));
 return Number(y)>0&&calendar.getUTCFullYear()===Number(y)&&calendar.getUTCMonth()===Number(m)-1&&calendar.getUTCDate()===Number(d)&&Number(h)<24&&Number(minute)<60&&Number(second)<60&&Number(offsetHour??0)<24&&Number(offsetMinute??0)<60&&Number.isFinite(Date.parse(value));
}
export function ownedPrivacyReceipt(value:unknown,owner:number,expectedId?:string):PrivacyReceipt {
 const r=record(value);
 if(r.owner_id!==owner||typeof r.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(r.id)||expectedId!==undefined&&r.id!==expectedId||!['export','delete'].includes(String(r.kind))||!['retention_review_required','cancelled','synthetic_drill_complete','synthetic_sql_complete'].includes(String(r.state))||r.legal_approval!==false||!instant(r.created_at)||!instant(r.expires_at)||Date.parse(r.expires_at)<Date.parse(r.created_at)||typeof r.notice!=='string'||r.notice.length>2000)throw new Error('Exact owned receipt required');
 return {id:r.id,owner_id:owner,kind:r.kind as 'export'|'delete',state:r.state as string,created_at:r.created_at,expires_at:r.expires_at,legal_approval:false,notice:r.notice};
}
export function ownedPrivacyHistory(value:unknown,owner:number):PrivacyHistory {
 const r=record(value);if(r.owner_id!==owner||r.real_deletion_enabled!==false||typeof r.has_more!=='boolean'||!Array.isArray(r.items)||r.items.length>100)throw new Error('Bounded owned history required');
 const items=r.items.map(row=>ownedPrivacyReceipt(row,owner));if(new Set(items.map(row=>row.id)).size!==items.length)throw new Error('Ambiguous request identities');
 return {owner_id:owner,items,has_more:r.has_more,real_deletion_enabled:false};
}
export function partialAccountSnapshot(value:unknown,owner:number):Record<string,unknown> {
 const r=record(value),coverage=record(r.coverage),profile=record(r.profile);
 if(r.schema_version!==1||r.owner_id!==owner||profile.id!==owner||r.complete_account_export!==false||r.complete_account_erasure!==false||r.real_deletion_enabled!==false||typeof r.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(r.content_hash)||!Object.keys(coverage).length||Object.keys(coverage).length>32||Object.values(coverage).some(v=>typeof v!=='string'||v.length>2000)||typeof coverage.files!=='string'||typeof coverage.backups!=='string')throw new Error('Exact partial snapshot required');
 for(const key of ['native_evidence','privacy_requests'])if(r[key]!==undefined&&record(r[key]).owner_id!==owner)throw new Error('Nested snapshot ownership changed');
 return r; // Full admitted download remains server-authored; no complete-erasure inference.
}
