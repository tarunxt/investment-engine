'use client';

import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Loader2, Play, X } from 'lucide-react';

import {
  buildConsensusRows,
  buildTechnicalScanPrompt,
  extractRebalanceInputFingerprint,
  fetchAllFullRuns,
  isCompletedRebalanceRun,
} from '@/app/console/_components/FinalActionablesConsole';
import { Button } from '@/components/ui/button';
import {
  buildRebalanceInputBundle,
  buildRebalancePrompt,
  getPreviousMarketClose,
  getRebalanceDefaultExportSheetName,
} from '@/lib/rebalance';
import {
  buildSwingTradePrompt,
  getSwingTradeDefaultExportSheetName,
  getSwingTradeDefaultInvestmentAmount,
  type SwingTradeMarket,
} from '@/lib/swingTrade';
import { isRunInSwingTradeMarket } from '@/lib/runPresentation';
import { apiService } from '@/services/api';
import type {
  IndMoneyUsPortfolioSnapshotCreateRequest,
  IndMoneyUsThreatAnalysis,
  ProviderInfo,
  ProviderModelTarget,
  RunCreate,
  RunResponse,
  ZerodhaThreatAnalysis,
} from '@/types/api';
import { normalizeError } from './dashboardOverviewUtils';

type WorkflowPortfolio = 'zerodha' | 'indmoneyUs';
type WorkflowStageKey = 'sync' | 'swing' | 'threats' | 'rebalance' | 'technical' | 'actionables';
type StageState = 'idle' | 'running' | 'completed' | 'failed';
type StageInfo = {
  state: StageState;
  completedAt?: string | null;
  provider?: string | null;
  model?: string | null;
  runStatus?: string | null;
  exportStatus?: string | null;
  costUsd?: number | null;
  costInr?: number | null;
  error?: string | null;
};
type WorkflowState = Record<WorkflowStageKey, StageInfo>;
type IndMoneySyncMode = 'reuse' | 'paste';

type SavedModelMix = {
  id: string;
  name: string;
  targets: string[];
};

const MODEL_MIX_STORAGE_KEY = 'investor:model-mixes:v1';
const AUTO_REBALANCE_MIX_NAME = 'Auto rebalance Models Mix';
const GPT_4O_MINI_MODEL = 'gpt-4o-mini';
const POLL_INTERVAL_MS = 3000;
const MAX_RUN_POLLS = 160;
const MAX_JOB_POLLS = 120;

const STAGE_ORDER: WorkflowStageKey[] = ['sync', 'swing', 'threats', 'rebalance', 'technical', 'actionables'];

const STAGE_COPY: Record<WorkflowStageKey, { idle: string; running: string; completed: string }> = {
  sync: { idle: 'Sync Portfolio', running: 'Syncing Portfolio', completed: 'Portfolio Synced' },
  swing: { idle: 'Swing Scan', running: 'Running Swing Scan', completed: 'Ran Swing Scan' },
  threats: { idle: 'Threats', running: 'Running Threats', completed: 'Ran Threats' },
  rebalance: { idle: 'Rebalance', running: 'Running Rebalance', completed: 'Ran Rebalance' },
  technical: { idle: 'Technical Scan', running: 'Running Technical Scan', completed: 'Ran Technical Scan' },
  actionables: { idle: 'Actionables', running: 'Updating Actionables', completed: 'Actionables Updated' },
};

function initialWorkflowState(): WorkflowState {
  return STAGE_ORDER.reduce((acc, stage) => {
    acc[stage] = { state: 'idle' };
    return acc;
  }, {} as WorkflowState);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseTimestampMs(value?: string | null) {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? new Date(normalized) : new Date(`${normalized}Z`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatTimestamp(value?: string | null) {
  if (!value) return 'Not available';
  const ms = parseTimestampMs(value);
  if (!ms) return value;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

function getStageLabel(stage: WorkflowStageKey, state: StageState) {
  if (state === 'running') return STAGE_COPY[stage].running;
  if (state === 'completed') return STAGE_COPY[stage].completed;
  return STAGE_COPY[stage].idle;
}

function getStageClasses(state: StageState) {
  if (state === 'completed') return 'border-emerald-300 bg-emerald-50 text-emerald-950 shadow-emerald-100';
  if (state === 'running') return 'border-amber-300 bg-amber-50 text-amber-950 shadow-amber-100';
  if (state === 'failed') return 'border-red-300 bg-red-50 text-red-950 shadow-red-100';
  return 'border-slate-200 bg-white text-slate-950 shadow-slate-100';
}

function summarizeRun(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  const firstJob = jobs[0];
  const costUsd = jobs.reduce((total, job) => total + (job.estimated_cost ?? 0), 0);
  const failedJob = jobs.find((job) => (job.status || '').toLowerCase() === 'failed' || job.error_message);
  return {
    completedAt: run.updated_at ?? firstJob?.updated_at ?? run.created_at,
    provider: jobs.length > 1 ? `${jobs.length} LLMs` : firstJob?.provider,
    model: jobs.length > 1 ? 'Model mix' : firstJob?.model,
    runStatus: run.status,
    exportStatus: run.export_status ?? firstJob?.export_status,
    costUsd: costUsd || null,
    costInr: null,
    error: run.export_error ?? failedJob?.error_message ?? null,
  };
}

function summarizeThreat(analysis: ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis) {
  return {
    completedAt: analysis.updated_at ?? analysis.created_at,
    provider: analysis.provider,
    model: analysis.model,
    runStatus: analysis.status,
    exportStatus: null,
    costUsd: analysis.estimated_cost ?? null,
    costInr: null,
    error: analysis.error_message ?? null,
  };
}

function getRunTargetsFromStoredMix(providers: ProviderInfo[]) {
  let parsed: SavedModelMix[] = [];
  try {
    const raw = window.localStorage.getItem(MODEL_MIX_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }

  const compatible = new Set(
    providers.flatMap((provider) =>
      provider.models
        .filter((model) => provider.model_compatibility?.[model]?.compatible !== false)
        .map((model) => `${provider.name}::${model}`),
    ),
  );

  const autoMix = parsed.find((mix) => mix?.name?.toLowerCase() === AUTO_REBALANCE_MIX_NAME.toLowerCase());
  const sourceTargets = autoMix?.targets?.length ? autoMix.targets : Array.from(compatible);

  return sourceTargets
    .filter((target) => compatible.has(target))
    .map((target) => {
      const [provider, model] = target.split('::');
      return { provider, model };
    });
}

function getGpt4oMiniTarget(providers: ProviderInfo[]): ProviderModelTarget | null {
  const provider = providers.find(
    (item) =>
      item.configured &&
      item.models.includes(GPT_4O_MINI_MODEL) &&
      item.model_compatibility?.[GPT_4O_MINI_MODEL]?.compatible !== false,
  );
  return provider ? { provider: provider.name, model: GPT_4O_MINI_MODEL } : null;
}

async function waitForRunCompletion(runId: number) {
  for (let attempt = 0; attempt < MAX_RUN_POLLS; attempt += 1) {
    const run = await apiService.getRun(runId);
    const status = (run.status || '').toLowerCase();
    if (status === 'completed' || status === 'failed') return run;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Run #${runId} did not finish before the dashboard timeout.`);
}

async function waitForThreatCompletion(
  portfolio: WorkflowPortfolio,
  jobId: number,
): Promise<ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis> {
  for (let attempt = 0; attempt < MAX_JOB_POLLS; attempt += 1) {
    const analysis = portfolio === 'zerodha'
      ? await apiService.zerodhaThreatJob(jobId)
      : await apiService.indmoneyUsThreatJob(jobId);
    const status = (analysis.status || '').toLowerCase();
    if (status === 'completed' || status === 'failed') return analysis;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Threat job #${jobId} did not finish before the dashboard timeout.`);
}

function getLatestMatchingRebalanceRuns(runs: RunResponse[], market: SwingTradeMarket) {
  const marketRuns = runs
    .filter((run) => isCompletedRebalanceRun(run, market))
    .sort((a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at));
  const latestRun = marketRuns[0];
  if (!latestRun) return [];
  const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
  return marketRuns.filter((run) => extractRebalanceInputFingerprint(run.prompt) === fingerprint);
}

function buildRunPayload({
  prompt,
  targets,
  sheetName,
}: {
  prompt: string;
  targets: ProviderModelTarget[];
  sheetName?: string;
}): RunCreate {
  return {
    prompt,
    targets,
    allow_parallel: true,
    auto_export_enabled: Boolean(sheetName),
    export_sheet_name: sheetName,
  };
}

function WorkflowStageTile({
  stage,
  info,
  onClick,
}: {
  stage: WorkflowStageKey;
  info: StageInfo;
  onClick?: () => void;
}) {
  const isRunning = info.state === 'running';
  const isCompleted = info.state === 'completed';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || isRunning}
      className={`relative min-h-36 rounded-2xl border p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${getStageClasses(info.state)}`}
    >
      {isCompleted ? (
        <CheckCircle2 className="absolute right-3 top-3 size-5 text-emerald-600" />
      ) : null}
      <div className="flex items-center gap-2 pr-7 text-sm font-semibold">
        {isRunning ? <Loader2 className="size-4 animate-spin text-amber-600" /> : <Clock3 className="size-4 text-slate-400" />}
        {getStageLabel(stage, info.state)}
      </div>
      <div className="mt-3 space-y-1 text-xs leading-5 text-slate-600">
        {info.completedAt ? <p>Timestamp: {formatTimestamp(info.completedAt)}</p> : null}
        {stage !== 'sync' && (info.provider || info.model || info.runStatus || info.exportStatus || info.costUsd || info.error) ? (
          <>
            <p>LLM: {[info.provider, info.model].filter(Boolean).join(' / ') || 'Not available'}</p>
            <p>LLM Run Status: {info.runStatus ?? 'Not available'}</p>
            <p>Sheets Export Status: {info.exportStatus ?? 'Not available'}</p>
            <p>Cost (USD / INR): {info.costUsd ? `$${info.costUsd.toFixed(4)}` : 'n/a'} / {info.costInr ? `₹${info.costInr.toFixed(2)}` : 'n/a'}</p>
            {info.error ? <p className="text-red-700">Error: {info.error}</p> : null}
          </>
        ) : null}
      </div>
    </button>
  );
}

function IndMoneySnapshotDialog({
  open,
  saving,
  error,
  onClose,
  onContinue,
}: {
  open: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onContinue: (mode: IndMoneySyncMode, payload?: IndMoneyUsPortfolioSnapshotCreateRequest) => void;
}) {
  const [mode, setMode] = useState<IndMoneySyncMode>('reuse');
  const [rawText, setRawText] = useState('');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">Sync INDmoney US Portfolio</h3>
            <p className="mt-1 text-sm text-slate-500">
              Continue with the last saved snapshot or paste the latest INDmoney screen before the rebalance workflow runs.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="rounded-2xl border border-slate-200 p-4 text-sm font-semibold text-slate-800">
            <input className="mr-2" type="radio" checked={mode === 'reuse'} onChange={() => setMode('reuse')} />
            Continue with last snapshot
          </label>
          <label className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-semibold text-blue-900">
            <input className="mr-2" type="radio" checked={mode === 'paste'} onChange={() => setMode('paste')} />
            Paste latest INDmoney snapshot
          </label>
        </div>

        {mode === 'paste' ? (
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder="Paste the copied INDmoney portfolio screen here..."
            className="mt-4 min-h-64 w-full resize-y rounded-2xl border border-blue-200 bg-white p-3 text-sm outline-none focus:border-blue-400"
          />
        ) : null}

        {error ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            type="button"
            disabled={saving || (mode === 'paste' && !rawText.trim())}
            onClick={() => onContinue(
              mode,
              mode === 'paste'
                ? { raw_text: rawText.trim(), captured_at: new Date().toISOString() }
                : undefined,
            )}
            className="bg-blue-600 text-white hover:bg-blue-500"
          >
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Continue Rebalance
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RebalanceWorkflowSections({ onDashboardRefresh }: { onDashboardRefresh: () => Promise<void> }) {
  const [states, setStates] = useState<Record<WorkflowPortfolio, WorkflowState>>({
    zerodha: initialWorkflowState(),
    indmoneyUs: initialWorkflowState(),
  });
  const [runningPortfolio, setRunningPortfolio] = useState<WorkflowPortfolio | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const isBusy = Boolean(runningPortfolio);

  const updateStage = useCallback((portfolio: WorkflowPortfolio, stage: WorkflowStageKey, info: Partial<StageInfo>) => {
    setStates((current) => ({
      ...current,
      [portfolio]: {
        ...current[portfolio],
        [stage]: { ...current[portfolio][stage], ...info },
      },
    }));
  }, []);

  const resetPortfolio = useCallback((portfolio: WorkflowPortfolio) => {
    setStates((current) => ({ ...current, [portfolio]: initialWorkflowState() }));
  }, []);

  const runWorkflow = useCallback(async (portfolio: WorkflowPortfolio, indmoneyPayload?: IndMoneyUsPortfolioSnapshotCreateRequest) => {
    const market: SwingTradeMarket = portfolio === 'zerodha' ? 'india' : 'us';
    setRunningPortfolio(portfolio);
    resetPortfolio(portfolio);

    let currentStage: WorkflowStageKey = 'sync';

    try {
      currentStage = 'sync';
      updateStage(portfolio, 'sync', { state: 'running', error: null });
      if (portfolio === 'zerodha') {
        const synced = await apiService.zerodhaSyncPortfolio();
        const overview = await apiService.zerodhaPortfolioOverview();
        updateStage(portfolio, 'sync', { state: 'completed', completedAt: overview.latest?.captured_at, runStatus: synced.status });
      } else if (indmoneyPayload) {
        const snapshot = await apiService.indmoneyUsCreatePortfolioSnapshot(indmoneyPayload);
        updateStage(portfolio, 'sync', { state: 'completed', completedAt: snapshot.captured_at, runStatus: snapshot.parse_status });
      } else {
        const overview = await apiService.indmoneyUsPortfolioOverview();
        updateStage(portfolio, 'sync', { state: 'completed', completedAt: overview.latest?.captured_at, runStatus: overview.latest?.parse_status ?? 'last snapshot' });
      }
      await onDashboardRefresh();

      const providers = await apiService.getProviders({ prompt: buildSwingTradePrompt(market, getSwingTradeDefaultInvestmentAmount(market)) });
      const modelMixTargets = getRunTargetsFromStoredMix(providers);
      if (modelMixTargets.length === 0) throw new Error(`No compatible targets found for ${AUTO_REBALANCE_MIX_NAME}.`);
      const gpt4oMiniTarget = getGpt4oMiniTarget(providers);
      if (!gpt4oMiniTarget) throw new Error(`${GPT_4O_MINI_MODEL} is not available from a configured provider.`);

      currentStage = 'swing';
      updateStage(portfolio, 'swing', { state: 'running', error: null });
      const swingRun = await apiService.createRun(buildRunPayload({
        prompt: buildSwingTradePrompt(market, getSwingTradeDefaultInvestmentAmount(market)),
        targets: modelMixTargets,
        sheetName: getSwingTradeDefaultExportSheetName(market),
      }));
      const completedSwingRun = await waitForRunCompletion(swingRun.id);
      if ((completedSwingRun.status || '').toLowerCase() !== 'completed') throw new Error(`Swing scan failed: ${summarizeRun(completedSwingRun).error ?? 'Run failed.'}`);
      updateStage(portfolio, 'swing', { state: 'completed', ...summarizeRun(completedSwingRun) });

      currentStage = 'threats';
      updateStage(portfolio, 'threats', { state: 'running', error: null });
      const queuedThreat = portfolio === 'zerodha'
        ? await apiService.zerodhaRunThreats(gpt4oMiniTarget)
        : await apiService.indmoneyUsRunThreats(gpt4oMiniTarget);
      const completedThreat = await waitForThreatCompletion(portfolio, queuedThreat.job_id);
      if ((completedThreat.status || '').toLowerCase() !== 'completed') throw new Error(`Threats scan failed: ${completedThreat.error_message ?? 'Job failed.'}`);
      updateStage(portfolio, 'threats', { state: 'completed', ...summarizeThreat(completedThreat) });

      currentStage = 'rebalance';
      updateStage(portfolio, 'rebalance', { state: 'running', error: null });
      const [portfolioRes, threatsRes, runsRes] = await Promise.all([
        portfolio === 'zerodha' ? apiService.zerodhaPortfolioOverview() : apiService.indmoneyUsPortfolioOverview(),
        portfolio === 'zerodha' ? apiService.zerodhaThreatsLatest() : apiService.indmoneyUsThreatsLatest(),
        apiService.getRuns({ page: 1, limit: 50, summary: true }),
      ]);
      const previousClose = getPreviousMarketClose(market);
      const recentCompletedRuns = runsRes.items
        .filter((run) => (run.status || '').toLowerCase() === 'completed')
        .filter((run) => parseTimestampMs(run.created_at) > previousClose.getTime())
        .slice(0, 24);
      const fullRunCandidates = await Promise.all(recentCompletedRuns.map((run) => apiService.getRun(run.id)));
      const swingRuns = fullRunCandidates.filter((run) => isRunInSwingTradeMarket(run.prompt, market)).slice(0, 12);
      const inputBundle = buildRebalanceInputBundle({
        market,
        previousClose,
        portfolio: portfolioRes.latest,
        threats: threatsRes.analysis,
        swingRuns,
        swingDisplayMode: 'full',
      });
      const rebalanceRun = await apiService.createRun(buildRunPayload({
        prompt: `${buildRebalancePrompt(market)}\n\n---\n\n${inputBundle}`.trim(),
        targets: modelMixTargets,
        sheetName: getRebalanceDefaultExportSheetName(market),
      }));
      const completedRebalanceRun = await waitForRunCompletion(rebalanceRun.id);
      if ((completedRebalanceRun.status || '').toLowerCase() !== 'completed') throw new Error(`Rebalance failed: ${summarizeRun(completedRebalanceRun).error ?? 'Run failed.'}`);
      updateStage(portfolio, 'rebalance', { state: 'completed', ...summarizeRun(completedRebalanceRun) });

      currentStage = 'technical';
      updateStage(portfolio, 'technical', { state: 'running', error: null });
      const allRuns = await fetchAllFullRuns();
      const consensus = buildConsensusRows(getLatestMatchingRebalanceRuns(allRuns, market), market);
      if (consensus.length === 0) throw new Error('No fresh rebalance consensus rows were available for technical scan.');
      const technicalRun = await apiService.createRun(buildRunPayload({
        prompt: buildTechnicalScanPrompt(consensus, market),
        targets: [gpt4oMiniTarget],
      }));
      const completedTechnicalRun = await waitForRunCompletion(technicalRun.id);
      if ((completedTechnicalRun.status || '').toLowerCase() !== 'completed') throw new Error(`Technical scan failed: ${summarizeRun(completedTechnicalRun).error ?? 'Run failed.'}`);
      updateStage(portfolio, 'technical', { state: 'completed', ...summarizeRun(completedTechnicalRun) });

      currentStage = 'actionables';
      updateStage(portfolio, 'actionables', { state: 'running', error: null });
      await onDashboardRefresh();
      updateStage(portfolio, 'actionables', { state: 'completed', completedAt: new Date().toISOString(), runStatus: 'fresh data loaded' });
    } catch (error) {
      const message = normalizeError(error);
      updateStage(portfolio, currentStage, { state: 'failed', error: message, runStatus: 'failed' });
    } finally {
      setRunningPortfolio(null);
    }
  }, [onDashboardRefresh, resetPortfolio, updateStage]);

  const handleIndMoneyContinue = useCallback((mode: IndMoneySyncMode, payload?: IndMoneyUsPortfolioSnapshotCreateRequest) => {
    setDialogError(null);
    setDialogOpen(false);
    void runWorkflow('indmoneyUs', mode === 'paste' ? payload : undefined);
  }, [runWorkflow]);

  const sections = useMemo(
    () => [
      { portfolio: 'zerodha' as const, title: 'Run Zerodha Rebalance', subtitle: 'Queue the India sync, scans, rebalance, technical scan, and final actionable refresh.' },
      { portfolio: 'indmoneyUs' as const, title: 'Run IndMoney Rebalance', subtitle: 'Use the latest INDmoney snapshot or paste a fresh screen before the US rebalance workflow.' },
    ],
    [],
  );

  return (
    <>
      <section className="grid gap-6 xl:grid-cols-2">
        {sections.map((section) => (
          <div key={section.portfolio} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">{section.title}</h2>
                <p className="mt-1 text-sm text-slate-500">{section.subtitle}</p>
              </div>
              <Button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  if (section.portfolio === 'indmoneyUs') {
                    setDialogError(null);
                    setDialogOpen(true);
                    return;
                  }
                  void runWorkflow('zerodha');
                }}
                className="rounded-full bg-slate-950 text-white hover:bg-slate-800"
              >
                {runningPortfolio === section.portfolio ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
                {section.title}
              </Button>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {STAGE_ORDER.map((stage) => (
                <WorkflowStageTile
                  key={stage}
                  stage={stage}
                  info={states[section.portfolio][stage]}
                  onClick={stage === 'sync' && section.portfolio === 'indmoneyUs' && !isBusy ? () => setDialogOpen(true) : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <IndMoneySnapshotDialog
        open={dialogOpen}
        saving={runningPortfolio === 'indmoneyUs'}
        error={dialogError}
        onClose={() => {
          if (runningPortfolio === 'indmoneyUs') return;
          setDialogOpen(false);
        }}
        onContinue={handleIndMoneyContinue}
      />
    </>
  );
}
