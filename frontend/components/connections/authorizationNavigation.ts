/** Browser URL contract only. Never store a request token across navigation. */
export function authorizationDestination(value:string, origin:string, syntheticRoundtrip=false){
 const url=new URL(value,origin);
 if(syntheticRoundtrip){
  if(url.origin===origin&&url.pathname==='/preview-kite'&&!url.hash&&!url.username&&!url.password)return url.href;
  throw new Error('Synthetic login must remain on the private preview');
 }
 if(url.origin==='https://kite.zerodha.com'&&url.pathname==='/connect/login'&&!url.hash&&!url.username&&!url.password)return url.href;
 throw new Error('Unapproved broker login destination');
}
export function returnedAuthorization(search:string){
 const query=new URLSearchParams(search);
 if(!query.has('request_token'))return null;
 for(const field of ['request_token','attempt_id','state'])if(query.getAll(field).length!==1||!query.get(field))throw new Error('Invalid callback');
 return {request_token:query.get('request_token')!,attempt_id:query.get('attempt_id')!,state:query.get('state')!};
}
