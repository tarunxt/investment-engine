import Link from 'next/link';
import {currentAdministrator} from '../_components/adminAccess';
export default async function AdminWorkspace(){
 if(!await currentAdministrator())return <section role="alert"><h1 className="text-2xl font-semibold">Administrator permission required</h1><p>Your personal workspace remains available. No provider or platform data was requested.</p><Link className="underline" href="/console/profile/usage">Open your personal usage</Link></section>;
 return <section className="space-y-5"><h1 className="text-3xl font-semibold">Administrator workspace</h1><p>Platform information is separate from personal investment research. Existing server permissions remain authoritative.</p><ul className="space-y-3"><li><Link className="underline" href="/console/apis">Provider usage and configuration status</Link></li><li><Link className="underline" href="/console/profile/cost-drivers">Platform cost drivers</Link></li></ul></section>;
}
