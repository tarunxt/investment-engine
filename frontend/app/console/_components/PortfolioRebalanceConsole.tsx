"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BriefcaseBusiness,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";

import {
  DashboardProvider,
  type DashboardPromptPreset,
  useDashboard,
} from "@/app/console/dashboard/_context";
import { CreateJobCard } from "@/app/console/dashboard/_components/CreateJobCard";
import { DashboardHeader } from "@/app/console/dashboard/_components/DashboardHeader";
import { RecentJobsTable } from "@/app/console/dashboard/_components/RecentJobsTable";
import { PortfolioAnalysisNav } from "@/components/shared/PortfolioAnalysisNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isRunInSwingTradeMarket } from "@/lib/runPresentation";
import {
  buildRebalanceInputBundle,
  buildRebalancePrompt,
  getPreviousMarketClose,
  getRebalanceDefaultExportSheetName,
  type RebalancePortfolioKey,
} from "@/lib/rebalance";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import { apiService } from "@/services/api";
import type {
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsThreatAnalysis,
  RunJobResponse,
  RunResponse,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaThreatAnalysis,
} from "@/types/api";

type PortfolioSnapshot =
  | ZerodhaPortfolioSnapshotDetail
  | IndMoneyUsPortfolioSnapshotDetail
  | null;
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
    title: "Zerodha",
    description:
      "Queue India portfolio rebalance runs using portfolio, swing-trade, and threats context.",
    consoleDescription:
      "Queue India rebalance jobs and monitor worker execution.",
  },
  indmoneyUs: {
    title: "IndMoney US",
    description:
      "Queue US portfolio rebalance runs using portfolio, swing-trade, and threats context.",
    consoleDescription: "Queue US rebalance jobs and monitor worker execution.",
  },
};

type RebalanceInputSectionKey = "portfolio" | "swing" | "threats";

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
    key: "portfolio",
    marker: "## 1. Latest Portfolio Snapshot",
    title: "Portfolio",
    eyebrow: "Holdings snapshot",
    description:
      "Latest synced book, units, prices, market value, PnL, and allocation context.",
    Icon: BriefcaseBusiness,
    shellClassName: "border-blue-200 bg-blue-50/70",
    iconClassName: "bg-blue-600 text-white",
  },
  {
    key: "swing",
    marker: "## 2. Completed Swing Trade Runs After Previous Market Close",
    title: "Swing",
    eyebrow: "Post-close runs",
    description:
      "Completed swing-trade model outputs created after the prior market-close cutoff.",
    Icon: TrendingUp,
    shellClassName: "border-emerald-200 bg-emerald-50/70",
    iconClassName: "bg-emerald-600 text-white",
  },
  {
    key: "threats",
    marker: "## 3. Latest Threats Report",
    title: "Threats",
    eyebrow: "Risk radar",
    description:
      "Latest portfolio threat analysis for downside, concentration, and news risks.",
    Icon: ShieldAlert,
    shellClassName: "border-rose-200 bg-rose-50/70",
    iconClassName: "bg-rose-600 text-white",
  },
];

function extractSection(bundle: string, marker: string, nextMarker?: string) {
  const start = bundle.indexOf(marker);
  if (start === -1) return "";
  const contentStart = start + marker.length;
  const end = nextMarker ? bundle.indexOf(nextMarker, contentStart) : -1;
  return bundle.slice(contentStart, end === -1 ? undefined : end).trim();
}

function buildInputSections(bundle: string) {
  return INPUT_SECTION_META.map((section, index) => ({
    ...section,
    content: extractSection(
      bundle,
      section.marker,
      INPUT_SECTION_META[index + 1]?.marker,
    ),
  }));
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Failed to load rebalance inputs.";
}

function composePrompt(basePrompt: string, inputBundle: string) {
  return `${basePrompt}\n\n---\n\n${inputBundle}`.trim();
}

function parseApiTimestampMs(value?: string | null) {
  if (!value || typeof value !== "string") return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatInputTimestamp(value?: string | null) {
  const ms = parseApiTimestampMs(value);
  if (ms === null) return value || "Unknown time";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function getSwingJobSelectionId(runId: number, link: RunJobResponse) {
  return `${runId}:${link.job_id}`;
}

function getRunJobResponseLength(link: RunJobResponse) {
  return link.job.response?.length ?? 0;
}

function getSelectedSwingRuns(
  runs: RunResponse[],
  selectedJobIds: ReadonlySet<string>,
) {
  return runs
    .map((run) => ({
      ...run,
      run_jobs: run.run_jobs.filter((link) =>
        selectedJobIds.has(getSwingJobSelectionId(run.id, link)),
      ),
    }))
    .filter((run) => run.run_jobs.length > 0);
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
  const [portfolioSnapshot, setPortfolioSnapshot] =
    useState<PortfolioSnapshot>(null);
  const [threatAnalysis, setThreatAnalysis] = useState<ThreatAnalysis>(null);
  const [swingRuns, setSwingRuns] = useState<RunResponse[]>([]);
  const [selectedSwingJobIds, setSelectedSwingJobIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const lastGeneratedPromptRef = useRef("");

  const previousClose = useMemo(() => getPreviousMarketClose(market), [market]);

  const loadInputs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [portfolioRes, threatsRes, runsRes] = await Promise.all([
        portfolio === "zerodha"
          ? apiService.zerodhaPortfolioOverview()
          : apiService.indmoneyUsPortfolioOverview(),
        portfolio === "zerodha"
          ? apiService.zerodhaThreatsLatest()
          : apiService.indmoneyUsThreatsLatest(),
        apiService.getRuns({ page: 1, limit: 50, summary: true }),
      ]);

      const recentCompletedRuns = runsRes.items
        .filter((run) => (run.status || "").toLowerCase() === "completed")
        .filter((run) => {
          const createdAtMs = parseApiTimestampMs(run.created_at);
          return createdAtMs !== null && createdAtMs > previousClose.getTime();
        })
        .slice(0, 24);

      const fullRunCandidates: RunResponse[] = await Promise.all(
        recentCompletedRuns.map((run) => apiService.getRun(run.id)),
      );
      const fullRuns = fullRunCandidates
        .filter((run) => isRunInSwingTradeMarket(run.prompt, market))
        .slice(0, 12);

      const allSwingJobIds = fullRuns.flatMap((run) =>
        run.run_jobs.map((link) => getSwingJobSelectionId(run.id, link)),
      );

      setPortfolioSnapshot(portfolioRes.latest as PortfolioSnapshot);
      setThreatAnalysis(threatsRes.analysis as ThreatAnalysis);
      setSwingRuns(fullRuns);
      setSelectedSwingJobIds(new Set(allSwingJobIds));
    } catch (err) {
      setError(normalizeError(err));
      setPortfolioSnapshot(null);
      setThreatAnalysis(null);
      setSwingRuns([]);
      setSelectedSwingJobIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [market, portfolio, previousClose]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInputs();
  }, [loadInputs]);

  const selectedSwingRuns = useMemo(
    () => getSelectedSwingRuns(swingRuns, selectedSwingJobIds),
    [selectedSwingJobIds, swingRuns],
  );

  const promptInputBundle = useMemo(() => {
    if (loading) return "Loading rebalance inputs…";
    if (error) {
      return "Failed to load one or more rebalance inputs. Refresh to try again.";
    }

    return buildRebalanceInputBundle({
      market,
      previousClose,
      portfolio: portfolioSnapshot,
      threats: threatAnalysis,
      swingRuns: selectedSwingRuns,
      swingDisplayMode: "full",
    });
  }, [
    error,
    loading,
    market,
    portfolioSnapshot,
    previousClose,
    selectedSwingRuns,
    threatAnalysis,
  ]);

  const displayInputBundle = useMemo(() => {
    if (loading) return "Loading rebalance inputs…";
    if (error) {
      return "Failed to load one or more rebalance inputs. Refresh to try again.";
    }

    return buildRebalanceInputBundle({
      market,
      previousClose,
      portfolio: portfolioSnapshot,
      threats: threatAnalysis,
      swingRuns: selectedSwingRuns,
      swingDisplayMode: "summary",
    });
  }, [
    error,
    loading,
    market,
    portfolioSnapshot,
    previousClose,
    selectedSwingRuns,
    threatAnalysis,
  ]);

  useEffect(() => {
    const nextPrompt = composePrompt(basePrompt, promptInputBundle);
    setPrompt((current) => {
      if (
        !current.trim() ||
        current === basePrompt ||
        current === lastGeneratedPromptRef.current
      ) {
        lastGeneratedPromptRef.current = nextPrompt;
        return nextPrompt;
      }
      return current;
    });
  }, [basePrompt, promptInputBundle, setPrompt]);

  const inputCount = promptInputBundle.length.toLocaleString("en-IN");
  const inputSections = useMemo(
    () => buildInputSections(displayInputBundle),
    [displayInputBundle],
  );
  const portfolioInputSection = inputSections.find(
    (section) => section.key === "portfolio",
  );
  const swingInputSection = inputSections.find(
    (section) => section.key === "swing",
  );
  const threatsInputSection = inputSections.find(
    (section) => section.key === "threats",
  );
  const selectedSwingJobCount = selectedSwingJobIds.size;
  const totalSwingJobCount = useMemo(
    () => swingRuns.reduce((total, run) => total + run.run_jobs.length, 0),
    [swingRuns],
  );
  const selectedSwingCharacterCount = useMemo(
    () =>
      swingRuns.reduce(
        (runTotal, run) =>
          runTotal +
          run.run_jobs.reduce((jobTotal, link) => {
            if (!selectedSwingJobIds.has(getSwingJobSelectionId(run.id, link))) {
              return jobTotal;
            }
            return jobTotal + getRunJobResponseLength(link);
          }, 0),
        0,
      ),
    [selectedSwingJobIds, swingRuns],
  );
  const allSwingJobsSelected =
    totalSwingJobCount > 0 && selectedSwingJobCount === totalSwingJobCount;

  function toggleSwingJob(jobId: string) {
    setSelectedSwingJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  }

  function setAllSwingJobsSelected(checked: boolean) {
    setSelectedSwingJobIds(
      checked
        ? new Set(
            swingRuns.flatMap((run) =>
              run.run_jobs.map((link) => getSwingJobSelectionId(run.id, link)),
            ),
          )
        : new Set(),
    );
  }

  return (
    <Card
      className="overflow-hidden border border-gray-200 shadow-sm"
      size="sm"
    >
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
                  {isExpanded ? "Expanded" : "Collapsed"}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Shows the portfolio snapshot, previous market close time,
                post-close swing-trade run references, and latest threats being
                sent to each rebalance model.
              </p>
              <p className="mt-2 text-xs text-gray-500">
                {loading
                  ? "Loading current inputs…"
                  : `${inputCount} characters of input context are included in the prompt below.`}
              </p>
            </div>
            <span className="rounded-full border border-gray-200 bg-white p-2 text-gray-500 shadow-sm transition group-hover:border-gray-300 group-hover:text-gray-800">
              {isExpanded ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </span>
          </button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadInputs()}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`}
            />
            Refresh Inputs
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          {inputSections.map(
            ({
              key,
              title,
              eyebrow,
              Icon,
              shellClassName,
              iconClassName,
              content,
            }) => (
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
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                    {eyebrow}
                  </span>
                  <span className="block truncate text-sm font-semibold text-gray-950">
                    {title}
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    {content
                      ? `${content.length.toLocaleString("en-IN")} chars`
                      : loading
                        ? "Loading…"
                        : "No data"}
                  </span>
                </span>
              </button>
            ),
          )}
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
            {[portfolioInputSection, threatsInputSection].map((section) => {
              if (!section) return null;
              const {
                key,
                title,
                description,
                Icon,
                shellClassName,
                iconClassName,
                content,
              } = section;
              return (
                <section
                  key={key}
                  className={`overflow-hidden rounded-xl border ${shellClassName}`}
                >
                  <div className="flex items-start gap-3 border-b border-white/70 bg-white/65 p-4">
                    <span className={`rounded-lg p-2 ${iconClassName}`}>
                      <Icon className="size-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-950">
                        {title}
                      </h3>
                      <p className="mt-1 text-xs text-gray-600">
                        {description}
                      </p>
                    </div>
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-gray-800">
                    {content ||
                      (loading
                        ? "Loading…"
                        : "No input available for this section.")}
                  </pre>
                  <div className="border-t border-white/70 bg-white/65 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                    {content
                      ? `${content.length.toLocaleString("en-IN")} characters`
                      : loading
                        ? "Counting characters…"
                        : "0 characters"}
                  </div>
                </section>
              );
            })}
          </div>

          {swingInputSection ? (
            <section
              className={`overflow-hidden rounded-xl border ${swingInputSection.shellClassName}`}
            >
              <div className="flex flex-col gap-3 border-b border-white/70 bg-white/65 p-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-start gap-3">
                  <span
                    className={`rounded-lg p-2 ${swingInputSection.iconClassName}`}
                  >
                    {(() => {
                      const SwingIcon = swingInputSection.Icon;
                      return <SwingIcon className="size-4" />;
                    })()}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-950">
                      {swingInputSection.title}
                    </h3>
                    <p className="mt-1 text-xs text-gray-600">
                      {swingInputSection.description}
                    </p>
                    <p className="mt-2 text-xs font-medium text-emerald-800">
                      {selectedSwingJobCount.toLocaleString("en-IN")} of{" "}
                      {totalSwingJobCount.toLocaleString("en-IN")} LLM outputs
                      selected ·{" "}
                      {selectedSwingCharacterCount.toLocaleString("en-IN")}{" "}
                      output characters selected
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-900 shadow-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
                    checked={allSwingJobsSelected}
                    disabled={loading || totalSwingJobCount === 0}
                    onChange={(event) =>
                      setAllSwingJobsSelected(event.target.checked)
                    }
                  />
                  Select all models
                </label>
              </div>

              <div className="space-y-3 p-4">
                {loading ? (
                  <div className="rounded-lg border border-emerald-100 bg-white/70 p-4 text-sm text-gray-600">
                    Loading swing-trade model outputs…
                  </div>
                ) : swingRuns.length === 0 ? (
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-emerald-100 bg-white/70 p-4 font-mono text-xs leading-5 text-gray-800">
                    {swingInputSection.content ||
                      "No completed swing-trade runs found after previous market close."}
                  </pre>
                ) : (
                  swingRuns.map((run) => (
                    <div
                      key={run.id}
                      className="overflow-hidden rounded-xl border border-emerald-100 bg-white/75 shadow-sm"
                    >
                      <div className="flex flex-col gap-1 border-b border-emerald-50 bg-emerald-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h4 className="text-sm font-semibold text-gray-950">
                            Run #{run.id} ·{" "}
                            {market === "us" ? "IndMoney US" : "Zerodha"}
                          </h4>
                          <p className="text-xs text-gray-600">
                            Created {formatInputTimestamp(run.created_at)} ·
                            export sheet {run.export_sheet_name || "n/a"}
                          </p>
                        </div>
                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                          {run.run_jobs.length.toLocaleString("en-IN")} models
                        </span>
                      </div>
                      <div className="divide-y divide-emerald-50">
                        {run.run_jobs.map((link) => {
                          const selectionId = getSwingJobSelectionId(
                            run.id,
                            link,
                          );
                          const isSelected =
                            selectedSwingJobIds.has(selectionId);
                          const outputLength = getRunJobResponseLength(link);
                          return (
                            <label
                              key={selectionId}
                              className={`grid cursor-pointer gap-3 px-4 py-3 transition hover:bg-emerald-50/60 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] md:items-center ${
                                isSelected
                                  ? "bg-white"
                                  : "bg-gray-50/80 opacity-70"
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">
                                  LLM model
                                </span>
                                <span className="mt-1 block truncate text-sm font-semibold text-gray-950">
                                  {link.job.provider}/{link.job.model}
                                </span>
                              </span>
                              <span className="min-w-0 text-xs text-gray-600">
                                <span className="block font-semibold uppercase tracking-[0.14em] text-gray-400">
                                  Timestamp
                                </span>
                                <span className="mt-1 block truncate">
                                  {formatInputTimestamp(link.job.updated_at)}
                                </span>
                              </span>
                              <span className="justify-self-start rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 md:justify-self-end">
                                Output length ·{" "}
                                {outputLength.toLocaleString("en-IN")} chars
                              </span>
                              <span className="flex items-center gap-2 justify-self-start rounded-full border border-emerald-100 bg-white px-3 py-2 text-xs font-semibold text-emerald-900 shadow-sm md:justify-self-end">
                                <input
                                  type="checkbox"
                                  className="size-4 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
                                  checked={isSelected}
                                  onChange={() => toggleSwingJob(selectionId)}
                                />
                                {isSelected ? "Included" : "Excluded"}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="border-t border-white/70 bg-white/65 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                {swingInputSection.content
                  ? `${swingInputSection.content.length.toLocaleString(
                      "en-IN",
                    )} characters in selected swing input summary`
                  : loading
                    ? "Counting characters…"
                    : "0 characters"}
              </div>
            </section>
          ) : null}

          <details className="rounded-xl border border-gray-200 bg-white p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
              Combined prompt input context
            </summary>
            <textarea
              value={promptInputBundle}
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
      initialInvestmentAmount: "",
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
            <h1 className="text-lg font-semibold tracking-tight text-gray-950">
              {copy.title}
            </h1>
            <p className="text-sm text-gray-500">{copy.description}</p>
          </div>
          <PortfolioAnalysisNav portfolio={portfolio} active="rebalance" />
        </div>

        <DashboardHeader
          title="Rebalance Console"
          description={copy.consoleDescription}
        />

        <div className="grid gap-6">
          <RebalanceInputBox
            portfolio={portfolio}
            market={market}
            basePrompt={basePrompt}
          />
          <CreateJobCard
            title="Create Job"
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
