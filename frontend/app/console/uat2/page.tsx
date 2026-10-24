'use client';
import Link from 'next/link';
import {SimulationConnections} from '@/components/uat2/SimulationConnections';
import {ServerAnalysis} from '@/app/console/automated-rebalance/_components/ServerAnalysis';
import {OrderReviews} from '@/components/modules/OrderReviews';
import {SimulationDiagnostics} from '@/components/uat2/SimulationDiagnostics';
import {AccountSupport} from '@/components/modules/AccountSupport';
export default function Uat2Page(){
 if(process.env.NEXT_PUBLIC_UAT2!=='true')return null;
 return <section className="space-y-6 p-6 min-w-0">
  <h1 className="text-2xl font-semibold">UAT2 owner simulation walkthrough</h1>
  <p>This isolated owner console uses fake connections, deterministic zero-cost analysis and durable fake execution. Real brokerage credentials, provider calls, external sends and live orders are unavailable.</p>
  <nav className="flex flex-wrap gap-4 underline"><Link href="/console/profile/preferences">Choose modules</Link><Link href="/console/indmoney-us">Preview and accept a US import</Link><Link href="/console/profile/activity">Recovery and recorded activity</Link></nav>
  <ol className="list-decimal pl-6 space-y-2"><li>Select the modules you want. Module selection grants no order consent.</li><li>For India, review either fake Kite mode and explicitly acquire a source. For US, preview and accept the import digest before analysis; only documented synthetic instruments are eligible in UAT2.</li><li>Start analysis and review all six durable stages. Closing the page does not stop server work.</li><li>Prepare a basket from completed India analysis. Review every exact instruction below and confirm it separately.</li><li>Refresh persisted order status after a timeout or worker restart. Partial or unknown execution never authorizes resubmission.</li></ol>
  <SimulationConnections/>
  <ServerAnalysis/>
  <OrderReviews/>
  <SimulationDiagnostics/>
  <AccountSupport/>
 </section>;
}
