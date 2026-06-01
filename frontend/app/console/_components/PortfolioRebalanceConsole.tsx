'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import {
  DashboardProvider,
  type DashboardPromptPreset,
  useDashboard,
} from '@/app/console/dashboard/_context';
import { CreateJobCard } from '@/app/console/dashboard/_components/CreateJobCard';
import { DashboardHeader } from '@/app/console/dashboard/_components/DashboardHeader';
import { RecentJobsTable } from '@/app/console/dashboard/_components/RecentJobsTable';
import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { isRunInSwingTradeMarket } from '@/lib/runPresentation';
import {
  buildRebalanceInputBundle,
  buildRebalancePrompt,
  getPreviousMarketClose,
  getRebalanceDefaultExportSheetName,
  type RebalancePortfolioKey,
} from '@/lib/rebalance';
import type { SwingTradeMarket } from '@/lib/swingTrade';
import { apiService } from '@/services/api';
import type {
  IndMoneyUsEventsAnalysis,
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsThreatAnalysis,
  RunResponse,
  ZerodhaEventsAnalysis,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaThreatAnalysis,
} from '@/types/api';

type PortfolioSnapshot = ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null;
type EventsAnalysis = ZerodhaEventsAnalysis | IndMoneyUsEventsAnalysis | null;
type ThreatAnalysis = ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis | null;

const PAGE_COPY: Record<
  RebalancePortfolioKey,
  {
    title: string;
    description: string;
    consoleDescription: string;
  }
> = {
  zerodha: {
    title: 'Zerodha',
    description: 'Queue India portfolio rebalance runs using portfolio, swing-trade, threats, and events context.',
    consoleDescription: 'Queue India rebalance jobs and monitor worker execution.',
  },
  indmoneyUs: {
    title: 'IndMoney US',
    description: 'Queue US portfolio rebalance runs using portfolio, swing-trade, threats, and events context.',
    consoleDescription: 'Queue US rebalance jobs and monitor worker execution.',
  },
};

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'Failed to load rebalance inputs.';
}

function composePrompt(basePrompt: string, inputBundle: string) {
  return `${basePrompt}\n\n---\n\n${inputBundle}`.trim();
}

function RebalanceInputBox({
  portfolio,
  market,
  basePrompt,
}: {
  portfolio: RebalancePortfolioKey;
  market: SwingTradeMarket;
  basePrompt: string;
}) {
  const { setPrompt } = useDashboard();
  const [inputBundle, setInputBundle] = useState('Loading rebalance inputs…');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastGeneratedPromptRef = useRef('');

  const previousClose = useMemo(() => getPreviousMarketClose(market), [market]);

  const loadInputs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [portfolioRes, eventsRes, threatsRes, runsRes] = await Promise.all([
        portfolio === 'zerodha'
          ? apiService.zerodhaPortfolioOverview()
          : apiService.indmoneyUsPortfolioOverview(),
        portfolio === 'zerodha'
          ? apiService.zerodhaEventsLatest()
          : apiService.indmoneyUsEventsLatest(),
        portfolio === 'zerodha'
          ? apiService.zerodhaThreatsLatest()
          : apiService.indmoneyUsThreatsLatest(),
        apiService.getRuns({ page: 1, limit: 50, summary: true }),
      ]);

      const candidateRuns = runsRes.items
        .filter((run) => (run.status || '').toLowerCase() === 'completed')
        .filter((run) => isRunInSwingTradeMarket(run.prompt_preview, market))
        .filter((run) => new Date(run.created_at).getTime() > previousClose.getTime())
        .slice(0, 12);

      const fullRuns: RunResponse[] = await Promise.all(
        candidateRuns.map((run) => apiService.getRun(run.id)),
      );

      const bundle = buildRebalanceInputBundle({
        market,
        previousClose,
        portfolio: portfolioRes.latest as PortfolioSnapshot,
        events: eventsRes.analysis as EventsAnalysis,
        threats: threatsRes.analysis as ThreatAnalysis,
        swingRuns: fullRuns,
      });
      setInputBundle(bundle);
    } catch (err) {
      setError(normalizeError(err));
      setInputBundle('Failed to load one or more rebalance inputs. Refresh to try again.');
    } finally {
      setLoading(false);
    }
  }, [market, portfolio, previousClose]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInputs();
  }, [loadInputs]);

  useEffect(() => {
    const nextPrompt = composePrompt(basePrompt, inputBundle);
    setPrompt((current) => {
      if (!current.trim() || current === basePrompt || current === lastGeneratedPromptRef.current) {
        lastGeneratedPromptRef.current = nextPrompt;
        return nextPrompt;
      }
      return current;
    });
  }, [basePrompt, inputBundle, setPrompt]);

  const inputCount = inputBundle.length.toLocaleString('en-IN');

  return (
    <Card className="border border-gray-200 shadow-sm" size="sm">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle>Input Box</CardTitle>
          <p className="mt-1 text-xs text-gray-500">
            Shows the portfolio snapshot, post-close swing-trade outputs, latest threats, and latest events being sent to each rebalance model.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadInputs()} disabled={loading}>
          <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh Inputs
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        <textarea
          value={inputBundle}
          readOnly
          className="min-h-[360px] w-full resize-y rounded-md border border-gray-200 bg-white p-3 font-mono text-xs leading-5 text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
        />
        <p className="text-xs text-gray-500">
          {loading ? 'Loading current inputs…' : `${inputCount} characters of input context are included in the prompt below.`}
        </p>
      </CardContent>
    </Card>
  );
}

export function PortfolioRebalanceConsole({
  portfolio,
  market,
}: {
  portfolio: RebalancePortfolioKey;
  market: SwingTradeMarket;
}) {
  const copy = PAGE_COPY[portfolio];
  const basePrompt = useMemo(() => buildRebalancePrompt(market), [market]);
  const promptPreset: DashboardPromptPreset = useMemo(
    () => ({
      initialInvestmentAmount: '',
      buildPrompt: () => basePrompt,
    }),
    [basePrompt],
  );

  return (
    <DashboardProvider
      defaultTemplateName={null}
      promptPreset={promptPreset}
      defaultExportSheetName={getRebalanceDefaultExportSheetName(market)}
      runScopeMarket={market}
      runScopeLabel={copy.title}
      runScopeKind="rebalance"
    >
      <div className="mx-auto flex flex-col gap-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-gray-950">{copy.title}</h1>
            <p className="text-sm text-gray-500">{copy.description}</p>
          </div>
          <PortfolioAnalysisNav portfolio={portfolio} active="rebalance" />
        </div>

        <DashboardHeader title="Rebalance Console" description={copy.consoleDescription} />

        <div className="grid gap-6">
          <RebalanceInputBox portfolio={portfolio} market={market} basePrompt={basePrompt} />
          <CreateJobCard
            title="Create Job"
            showGoogleSheetsInvestmentAmount={false}
            collapsible
            defaultExpanded
            runActionLabel="Run Rebalance"
            runButtonClassName="bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:border-emerald-600 focus-visible:ring-emerald-300"
          />
          <RecentJobsTable />
        </div>
      </div>
    </DashboardProvider>
  );
}
