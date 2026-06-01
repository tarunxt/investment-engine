'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BellRing, BriefcaseBusiness, ChevronDown, ChevronUp, RefreshCw, ShieldAlert, TrendingUp } from 'lucide-react';

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


type RebalanceInputSectionKey = 'portfolio' | 'swing' | 'threats' | 'events';

const INPUT_SECTION_META: Array<{
  key: RebalanceInputSectionKey;
  marker: string;
  title: string;
  eyebrow: string;
  description: string;
  Icon: typeof BriefcaseBusiness;
  shellClassName: string;
  iconClassName: string;
}> = [
  {
    key: 'portfolio',
    marker: '## 1. Latest Portfolio Snapshot',
    title: 'Portfolio',
    eyebrow: 'Holdings snapshot',
    description: 'Latest synced book, units, prices, market value, PnL, and allocation context.',
    Icon: BriefcaseBusiness,
    shellClassName: 'border-blue-200 bg-blue-50/70',
    iconClassName: 'bg-blue-600 text-white',
  },
  {
    key: 'swing',
    marker: '## 2. Completed Swing Trade Runs After Previous Market Close',
    title: 'Swing',
    eyebrow: 'Post-close runs',
    description: 'Completed swing-trade model outputs created after the prior market-close cutoff.',
    Icon: TrendingUp,
    shellClassName: 'border-emerald-200 bg-emerald-50/70',
    iconClassName: 'bg-emerald-600 text-white',
  },
  {
    key: 'threats',
    marker: '## 3. Latest Threats Report',
    title: 'Threats',
    eyebrow: 'Risk radar',
    description: 'Latest portfolio threat analysis for downside, concentration, and news risks.',
    Icon: ShieldAlert,
    shellClassName: 'border-rose-200 bg-rose-50/70',
    iconClassName: 'bg-rose-600 text-white',
  },
  {
    key: 'events',
    marker: '## 4. Latest Events Report',
    title: 'Events',
    eyebrow: 'Catalyst calendar',
    description: 'Upcoming earnings, corporate actions, macro dates, and other price-sensitive catalysts.',
    Icon: BellRing,
    shellClassName: 'border-violet-200 bg-violet-50/70',
    iconClassName: 'bg-violet-600 text-white',
  },
];

function extractSection(bundle: string, marker: string, nextMarker?: string) {
  const start = bundle.indexOf(marker);
  if (start === -1) return '';
  const contentStart = start + marker.length;
  const end = nextMarker ? bundle.indexOf(nextMarker, contentStart) : -1;
  return bundle.slice(contentStart, end === -1 ? undefined : end).trim();
}

function buildInputSections(bundle: string) {
  return INPUT_SECTION_META.map((section, index) => ({
    ...section,
    content: extractSection(bundle, section.marker, INPUT_SECTION_META[index + 1]?.marker),
  }));
}

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
  const [isExpanded, setIsExpanded] = useState(false);
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
  const inputSections = useMemo(() => buildInputSections(inputBundle), [inputBundle]);

  return (
    <Card className="overflow-hidden border border-gray-200 shadow-sm" size="sm">
      <CardHeader className="gap-4 bg-gradient-to-r from-gray-50 via-white to-gray-50">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
            className="group flex min-w-0 flex-1 items-start justify-between gap-4 text-left"
          >
            <div>
              <div className="flex items-center gap-2">
                <CardTitle>Input Box</CardTitle>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                  {isExpanded ? 'Expanded' : 'Collapsed'}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Shows the portfolio snapshot, post-close swing-trade outputs, latest threats, and latest events being sent to each rebalance model.
              </p>
              <p className="mt-2 text-xs text-gray-500">
                {loading ? 'Loading current inputs…' : `${inputCount} characters of input context are included in the prompt below.`}
              </p>
            </div>
            <span className="rounded-full border border-gray-200 bg-white p-2 text-gray-500 shadow-sm transition group-hover:border-gray-300 group-hover:text-gray-800">
              {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </span>
          </button>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadInputs()} disabled={loading}>
            <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh Inputs
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-4">
          {inputSections.map(({ key, title, eyebrow, Icon, shellClassName, iconClassName, content }) => (
            <button
              key={key}
              type="button"
              onClick={() => setIsExpanded(true)}
              className={`flex items-center gap-3 rounded-xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm ${shellClassName}`}
            >
              <span className={`rounded-lg p-2 ${iconClassName}`}>
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">{eyebrow}</span>
                <span className="block truncate text-sm font-semibold text-gray-950">{title}</span>
                <span className="block text-[11px] text-gray-500">
                  {content ? `${content.length.toLocaleString('en-IN')} chars` : loading ? 'Loading…' : 'No data'}
                </span>
              </span>
            </button>
          ))}
        </div>
      </CardHeader>
      {isExpanded ? (
        <CardContent className="space-y-4 pt-4">
          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2">
            {inputSections.map(({ key, title, description, Icon, shellClassName, iconClassName, content }) => (
              <section key={key} className={`overflow-hidden rounded-xl border ${shellClassName}`}>
                <div className="flex items-start gap-3 border-b border-white/70 bg-white/65 p-4">
                  <span className={`rounded-lg p-2 ${iconClassName}`}>
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-950">{title}</h3>
                    <p className="mt-1 text-xs text-gray-600">{description}</p>
                  </div>
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-gray-800">
                  {content || (loading ? 'Loading…' : 'No input available for this section.')}
                </pre>
              </section>
            ))}
          </div>

          <details className="rounded-xl border border-gray-200 bg-white p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
              Combined raw input context
            </summary>
            <textarea
              value={inputBundle}
              readOnly
              className="mt-3 min-h-[260px] w-full resize-y rounded-md border border-gray-200 bg-white p-3 font-mono text-xs leading-5 text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
            />
          </details>
        </CardContent>
      ) : null}
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
