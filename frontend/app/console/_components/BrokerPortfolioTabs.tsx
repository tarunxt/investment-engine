'use client';

import { type ReactNode, useSyncExternalStore } from 'react';
import { PortfolioWorkflowSlot, type WorkflowMarket } from './WorkflowSurfaceSlots';

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

export function BrokerPortfolioTabs({ market, children }: { market: WorkflowMarket; children: ReactNode }) {
  const broker = market === 'zerodha' ? 'Zerodha' : 'IndMoney';
  const workflowHash = market === 'zerodha' ? '#india-workflow' : '#us-workflow';
  const showWorkflow = useSyncExternalStore(subscribe, () => window.location.hash === workflowHash, () => false);
  const tabs = [
    { label: 'Rebalance', href: workflowHash, current: showWorkflow },
    { label: `My ${broker} Portfolio`, href: '#broker-portfolio', current: !showWorkflow },
  ];

  return (
    <>
      <nav aria-label={`${broker} views`} className="mb-4 flex gap-6 border-b border-gray-200">
        {tabs.map(({ label, href, current }) => (
          <a key={href} href={href} aria-current={current ? 'page' : undefined}
            className={`border-b-[3px] px-1 py-3 text-sm font-medium focus-visible:outline-offset-2 ${current ? 'border-emerald-600 text-gray-950' : 'border-transparent text-gray-600 hover:text-gray-950'}`}>
            {label}
          </a>
        ))}
      </nav>
      <div id="broker-portfolio" hidden={showWorkflow}>{children}</div>
      <div hidden={!showWorkflow}><PortfolioWorkflowSlot market={market} /></div>
    </>
  );
}
