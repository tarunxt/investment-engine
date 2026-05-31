'use client';

import {
  DashboardProvider,
  type DashboardPromptPreset,
} from '@/app/console/dashboard/_context';
import { CreateJobCard } from '@/app/console/dashboard/_components/CreateJobCard';
import { DashboardHeader } from '@/app/console/dashboard/_components/DashboardHeader';
import { RecentJobsTable } from '@/app/console/dashboard/_components/RecentJobsTable';
import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import {
  buildSwingTradePrompt,
  getSwingTradeDefaultInvestmentAmount,
  getSwingTradeDefaultExportSheetName,
  syncSwingTradePrompt,
  type SwingTradeMarket,
} from '@/lib/swingTrade';
import { SwingTradeInvestmentAmountField } from './SwingTradeInvestmentAmountField';

type PortfolioKey = 'zerodha' | 'indmoneyUs';

const PAGE_COPY: Record<
  PortfolioKey,
  {
    title: string;
    description: string;
    consoleDescription: string;
  }
> = {
  zerodha: {
    title: 'Zerodha',
    description: 'Queue aggressive India swing-trade research runs alongside your Zerodha workflow.',
    consoleDescription:
      'Queue India swing-trade research jobs and monitor worker execution.',
  },
  indmoneyUs: {
    title: 'IndMoney US',
    description: 'Queue aggressive US swing-trade research runs alongside your INDmoney US workflow.',
    consoleDescription:
      'Queue US swing-trade research jobs and monitor worker execution.',
  },
};

export function PortfolioSwingTradeConsole({
  portfolio,
  market,
}: {
  portfolio: PortfolioKey;
  market: SwingTradeMarket;
}) {
  const copy = PAGE_COPY[portfolio];
  const promptPreset: DashboardPromptPreset = {
    initialInvestmentAmount: getSwingTradeDefaultInvestmentAmount(market),
    buildPrompt: (investmentAmount) => buildSwingTradePrompt(market, investmentAmount),
    syncPrompt: (currentPrompt, previousInvestmentAmount, nextInvestmentAmount) =>
      syncSwingTradePrompt(market, currentPrompt, previousInvestmentAmount, nextInvestmentAmount),
  };

  return (
    <DashboardProvider
      defaultTemplateName={null}
      promptPreset={promptPreset}
      defaultExportSheetName={getSwingTradeDefaultExportSheetName(market)}
      runScopeMarket={market}
      runScopeLabel={copy.title}
    >
      <div className="mx-auto flex flex-col gap-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-gray-950">{copy.title}</h1>
            <p className="text-sm text-gray-500">{copy.description}</p>
          </div>
          <PortfolioAnalysisNav portfolio={portfolio} active="swingTrade" />
        </div>

        <DashboardHeader
          title="Swing Trade Console"
          description={copy.consoleDescription}
        />

        <div className="grid gap-6">
          <CreateJobCard
            promptAside={<SwingTradeInvestmentAmountField market={market} />}
            showGoogleSheetsInvestmentAmount={false}
            collapsible
            defaultExpanded={false}
            runActionLabel="Run Swing Trade Scan"
            runButtonClassName="bg-blue-600 text-white hover:bg-blue-500 focus-visible:border-blue-600 focus-visible:ring-blue-300"
          />
          <RecentJobsTable />
        </div>
      </div>
    </DashboardProvider>
  );
}
