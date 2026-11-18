'use client';

import { type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react';
import { AuthContext } from '@/hooks/useAuth';
import { PortfolioWorkflowSlot, type WorkflowMarket } from './WorkflowSurfaceSlots';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

export function BrokerPortfolioTabs({ market, children }: { market: WorkflowMarket; children: ReactNode }) {
  const broker = market === 'zerodha' ? 'Zerodha' : 'IndMoney';
  const workflowHash = market === 'zerodha' ? '#india-workflow' : '#us-workflow';
  const userId = useContext(AuthContext)?.user?.id;
  const preferenceKey = userId ? `credx:broker-tab:${userId}:${market}` : null;
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => '');
  const rememberedWorkflow = useSyncExternalStore(subscribe, () => {
    try {
      return preferenceKey !== null && window.localStorage.getItem(preferenceKey) === 'rebalance';
    } catch {
      return false;
    }
  }, () => false);
  const showWorkflow = hash ? hash === workflowHash : rememberedWorkflow;

  useEffect(() => {
    if (!hash || !preferenceKey) return;
    try {
      window.localStorage.setItem(preferenceKey, hash === workflowHash ? 'rebalance' : 'portfolio');
    } catch {
      // Fragment navigation still works when browser storage is unavailable.
    }
  }, [hash, preferenceKey, workflowHash]);
  const tabs = [
    { label: 'Rebalance', href: workflowHash, current: showWorkflow },
    { label: `My ${broker} Portfolio`, href: '#broker-portfolio', current: !showWorkflow },
  ];

  return (
    <>
      <nav aria-label={`${broker} views`} className="sticky top-0 z-[9] mb-4 flex gap-6 border-b border-gray-200 bg-background pl-12 lg:pl-0">
        {tabs.map(({ label, href, current }) => (
          <a key={href} href={href} aria-current={current ? 'page' : undefined}
            className={`border-b-[3px] px-1 py-3 text-sm font-medium focus-visible:outline-offset-2 ${current ? 'border-emerald-600 text-gray-950' : 'border-transparent text-gray-600 hover:text-gray-950'}`}>
            {label}
          </a>
        ))}
      </nav>
      <div id="broker-portfolio" className="scroll-mt-16" hidden={showWorkflow}>{children}</div>
      <div hidden={!showWorkflow}><PortfolioWorkflowSlot market={market} /></div>
    </>
  );
}
