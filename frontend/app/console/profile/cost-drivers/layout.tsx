import type { ReactNode } from "react";
import { OptimizationActionCenter } from "./OptimizationActionCenter";
import {currentCostAdministrator} from '../../_components/adminAccess';
import Link from 'next/link';

export default async function CostDriversLayout({ children }: { children: ReactNode }) {
  if(!await currentCostAdministrator())return <section role="alert" className="space-y-3"><h1 className="text-2xl font-semibold">Platform cost permission required</h1><p>No cloud billing or provider data was requested. Your personal usage is available separately.</p><Link className="underline" href="/console/profile/usage">Open your usage</Link></section>;
  return (
    <div className="space-y-6">
      <OptimizationActionCenter />
      {children}
    </div>
  );
}
