import {notFound} from 'next/navigation';

export default async function SyntheticBrokerLogin({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 if(process.env.STAGE01_PREVIEW!=='synthetic-only')notFound();
 const query=await searchParams;
 if(typeof query.redirect_params!=='string')notFound();
 const returned=new URLSearchParams(query.redirect_params);
 if(returned.getAll('state').length!==1||returned.getAll('attempt_id').length!==1)notFound();
 const state=returned.get('state'),attempt=returned.get('attempt_id');
 if(!state||!attempt)notFound();
 const callback='/console/profile/connections?'+new URLSearchParams({state,attempt_id:attempt,request_token:'fake-ok'});
 return <main className="mx-auto max-w-xl space-y-5 p-8"><h1 className="text-xl font-semibold">Synthetic broker authorization</h1><p>Local fake transport only. No Kite login, credentials, provider permission or financial operation occurs.</p><a className="inline-block rounded border px-4 py-3" href={callback}>Authorize synthetic broker account</a></main>;
}
