/** Inert owner-scoped operation identity; never credentials or deletion authority. */
export type PrivacyStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function privacyRecoverySlot(owner:number):string {
 if(!Number.isSafeInteger(owner)||owner<=0)throw new Error('Verified owner required');
 return `investment-engine:private:v1:${owner}:investment-engine:privacy-review-pending:v1`;
}
function admittedKey(value:unknown):value is string{return typeof value==='string'&&/^privacy-review:[a-zA-Z0-9-]{1,80}$/.test(value);}
export function readPrivacyRecovery(storage:PrivacyStorage,owner:number):string|null {
 const raw=storage.getItem(privacyRecoverySlot(owner));if(raw===null)return null;
 const row=JSON.parse(raw);if(!row||row.version!==1||row.owner_id!==owner||!admittedKey(row.key))throw new Error('Owned pending identity unavailable');return row.key;
}
export function retainPrivacyRecovery(storage:PrivacyStorage,owner:number,key:string):void {
 if(!admittedKey(key))throw new Error('Exact operation identity required');
 const previous=readPrivacyRecovery(storage,owner);if(previous!==null&&previous!==key)throw new Error('Existing pending identity must be reconciled');
 storage.setItem(privacyRecoverySlot(owner),JSON.stringify({version:1,owner_id:owner,key}));
 if(readPrivacyRecovery(storage,owner)!==key)throw new Error('Operation identity was not retained');
}
export function clearPrivacyRecovery(storage:PrivacyStorage,owner:number,key:string):void {
 if(readPrivacyRecovery(storage,owner)!==key)throw new Error('Pending identity changed');
 storage.removeItem(privacyRecoverySlot(owner));if(readPrivacyRecovery(storage,owner)!==null)throw new Error('Pending identity remains');
}
