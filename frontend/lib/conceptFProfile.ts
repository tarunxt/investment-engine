/** Validate a saved preference for display; never substitute a browser/default zone. */
export function recordedTimeZone(value:unknown):string|null{if(typeof value!=='string'||!value.trim()||value.length>128)return null;try{new Intl.DateTimeFormat('en',{timeZone:value.trim()}).format(0);return value.trim();}catch{return null;}}
