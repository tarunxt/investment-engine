"use client";

import { TechnicalValidation } from "./TechnicalValidation";
import { PairwiseCoverage } from "./PairwiseCoverage";
import { ThreatStockScores } from "./ThreatStockScores";
import { TechnicalStockScores } from "./TechnicalStockScores";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, ChartCandlestick, GitCompareArrows, ShieldCheck } from "lucide-react";
import { StandardLlmOutputRenderer } from "@/components/shared/StandardLlmOutputRenderer";
import { SavedOutputDialog } from "@/components/shared/SavedOutputDialog";
import { formatDuration } from "@/components/shared/WorkflowStageTile";
import { StageDurationBreakdownDialog } from "./StageDurationBreakdownDialog";
import { useRebalanceCostQuote } from "@/hooks/useRebalanceCostQuote";
import { formatApiTimestamp, formatCompactStageTime } from "@/lib/datetime";
import { cards, scorecardApi, type CardKey } from "@/lib/independentScorecards";
import {
  cardNames,
  inputRevision,
  scorecardHref,
  scorecardTabs,
  stageExecutions,
  type ScorecardMarket,
  type ScorecardPath,
  type ScorecardTab,
} from "@/lib/scorecardNavigation";
import { formatRebalanceCost } from "@/lib/rebalanceCost";
import { historicalStageInfo } from "@/lib/portfolioStageHistory";
import { URLs } from "@/lib/urls";
import type { apiService } from "@/services/api";
import type {
  AutoRebalanceHistoryItemResponse,
  AutoRebalanceJobDetailResponse,
  RunResponse,
} from "@/types/api";

type Client = typeof apiService;
type Base = { market: ScorecardMarket; client: Client; renderOutput: (run: RunResponse, card: CardKey) => ReactNode };
type Tools = {
  onModels: (card: CardKey) => void;
  onInputs: (card: CardKey) => void;
  onTemplate: (card: Exclude<CardKey, "pairwise">) => void;
  onStockFlow: () => void;
  onManage: (card: CardKey, revision?: number, attempt?: number) => void;
};
const button =
  "inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-50 disabled:opacity-50";
const panel = "min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6";
const tones = {
  rebalance: "border-indigo-200 bg-indigo-50 text-indigo-900",
  technical: "border-sky-200 bg-sky-50 text-sky-900",
  threats: "border-amber-200 bg-amber-50 text-amber-950",
  pairwise: "border-teal-200 bg-teal-50 text-teal-900",
};
const icons = {
  rebalance: Activity,
  technical: ChartCandlestick,
  threats: ShieldCheck,
  pairwise: GitCompareArrows,
};
const brokerKey = (market: ScorecardMarket) => (market === "zerodha" ? "india" : "indmoney_us");
const brokerName = (market: ScorecardMarket) => (market === "zerodha" ? "Zerodha India" : "INDmoney US");
const title = (card: CardKey) => cardNames[card] + " Scorecards";
const elapsed = (start?: string | null, end?: string | null) =>
  start && end ? (formatDuration(start, end) ?? "—") : "—";

function Status({ value }: { value: string }) {
  const color =
    value === "completed"
      ? "bg-emerald-100 text-emerald-900"
      : ["failed", "interrupted", "cancelled"].includes(value)
        ? "bg-rose-100 text-rose-900"
        : value === "partial"
          ? "bg-amber-100 text-amber-950"
          : "bg-sky-100 text-sky-950";
  return (
    <span className={"inline-block rounded-full px-2.5 py-1 text-xs font-semibold capitalize " + color}>
      {value}
    </span>
  );
}
function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: { key: string | number; cells: ReactNode[] }[];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-4 py-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.key} className="even:bg-slate-50/60">
              {row.cells.map((cell, i) => (
                <td key={columns[i]} className="px-4 py-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={columns.length} className="p-4 text-slate-600">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
// Each result belongs to its exact request, including during rapid navigation and retries.
function useRead<T>(read: () => Promise<T>, enabled = true) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ read: typeof read; version: number; value?: T; error?: string }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.resolve()
      .then(read)
      .then(
        (value) => {
          if (active) setResult({ read, version, value });
        },
        (error) => {
          if (active)
            setResult({ read, version, error: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      active = false;
    };
  }, [read, enabled, version]);
  const current = enabled && result?.read === read && result.version === version ? result : undefined;
  return {
    data: current?.value,
    error: current?.error,
    loading: enabled && !current,
    retry: () => setVersion((n) => n + 1),
  };
}
function Feedback({ query }: { query: { loading: boolean; error?: string; retry: () => void } }) {
  if (query.loading)
    return (
      <p role="status" className="p-4 text-sm text-indigo-700">
        Loading saved records…
      </p>
    );
  if (query.error)
    return (
      <p role="alert" className="rounded-xl bg-rose-50 p-4 text-rose-900">
        {query.error}{" "}
        <button className={button} onClick={query.retry}>
          Retry
        </button>
      </p>
    );
  return null;
}

function Catalogue({ market, card, client }: Pick<Base, "market" | "client"> & { card?: CardKey }) {
  const { rate } = useRebalanceCostQuote();
  const [page, setPage] = useState(0);
  const size = 25;
  const read = useCallback(
    () => client.getAutoRebalanceHistory(brokerKey(market), { limit: size, offset: page * size }),
    [client, market, page],
  );
  const result = useRead(read);
  const items = result.data?.items ?? [];
  const link = (c: CardKey, r: AutoRebalanceHistoryItemResponse) => (
    <Link href={scorecardHref(market, c, r.sequence)} className="font-semibold text-indigo-700 underline">
      Run #{r.sequence}
    </Link>
  );
  return (
    <>
      {!card && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((c) => {
            const stage = items
              .find((i) => i.stages.some((s) => s.stage === c))
              ?.stages.find((s) => s.stage === c);
            const Icon = icons[c];
            return (
              <Link
                key={c}
                href={scorecardHref(market, c)}
                className={"rounded-2xl border p-5 shadow-sm hover:shadow-md " + tones[c]}
              >
                <Icon className="mb-4 size-6" />
                <h2 className="flex items-center justify-between text-lg font-semibold">
                  {title(c)}
                  <ArrowUpRight className="size-4" />
                </h2>
                {stage && (
                  <p className="mt-2 text-sm">
                    {formatCompactStageTime(stage.started_at)} · {stage.status}
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      )}
      <section className={panel}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{card ? "Run history" : "Scorecard runs"}</h2>
          <button className={button} onClick={result.retry}>
            Refresh
          </button>
        </div>
        <Feedback query={result} />
        {result.data && (
          <>
            <Table
              columns={[
                "Workflow run",
                "Scorecard",
                "Stage status",
                "Started",
                "LLM jobs",
                "Duration",
                "Cost",
              ]}
              empty="No scorecard runs on this page."
              rows={items.flatMap((item) =>
                item.stages.flatMap((stage) => {
                  const c = cards.find((key) => stage.stage === key && (!card || card === key));
                  return c
                    ? [
                        {
                          key: item.sequence + "-" + c,
                          cells: [
                            link(c, item),
                            cardNames[c],
                            <Status key="status" value={stage.status} />,
                            formatCompactStageTime(stage.started_at),
                            stage.provider_count,
                            elapsed(stage.started_at, stage.completed_at),
                            formatRebalanceCost(historicalStageInfo(stage), rate),
                          ],
                        },
                      ]
                    : [];
                }),
              )}
            />
            <div className="mt-4 flex items-center justify-between text-sm">
              <button className={button} disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
                Newer runs
              </button>
              <span>
                Workflow page {page + 1} of {Math.max(1, Math.ceil(result.data.total / size))}
              </span>
              <button
                className={button}
                disabled={(page + 1) * size >= result.data.total}
                onClick={() => setPage((n) => n + 1)}
              >
                Older runs
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}

type EvidenceProps = Base & {
  card: CardKey;
  sequence: number;
  tab: ScorecardTab;
  execution: number | null;
  account?: string;
  onTab: (tab: ScorecardTab) => void;
  onExecution: (id: number) => void;
  tools?: Partial<Tools>;
  refresh?: number;
};
function Evidence({
  market,
  client,
  card,
  sequence,
  tab,
  execution,
  account,
  renderOutput,
  onTab,
  onExecution,
  tools,
  refresh = 0,
}: EvidenceProps) {
  const { rate } = useRebalanceCostQuote();
  const [durationOpen, setDurationOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const retryKeys = useRef(new Map<number,string>());
  const api = useMemo(() => scorecardApi(client, brokerKey(market)), [client, market]);
  const readHistory = useCallback(
    () => client.getAutoRebalanceHistoryDetail(brokerKey(market), sequence),
    [client, market, sequence, refresh],
  );
  const history = useRead(readHistory);
  const stage = history.data?.stages.find((s) => s.stage === card);
  const { runs, standalone } =
    history.data && stage ? stageExecutions(history.data, stage) : { runs: [], standalone: [] };
  const readCoverage = useCallback(()=>api.coverage(sequence),[api,sequence,refresh]);
  const coverage = useRead(readCoverage,card==="technical" || card==="pairwise" || (card==="threats" && market==="zerodha"));
  const published = card==="technical" || card==="pairwise" || (card==="threats" && market==="zerodha") ? coverage.data?.cards[card] : undefined;
  const run =
    published && execution===null && !published.run_id ? undefined : execution !== null
      ? runs.find((r) => r.id === execution)
      : (runs.find((r) => r.id === (published?.run_id ?? stage?.run_id)) ?? runs[0]);
  const jobs = run?.jobs ?? (execution === null && !(published && !published.run_id) ? standalone : []);
  const runId = run?.id;
  const revision = inputRevision(run?.prompt, card, market) ?? ((card==="technical" || card==="pairwise" || card==="threats") && !runId ? coverage.data?.revision_id : null);
  const readTemplate = useCallback(() => api.prompt(revision!, card), [api, revision, card]);
  const template = useRead(readTemplate, !!revision && tab === "prompts" && templateOpen);
  const readSource = useCallback(() => api.read(revision!), [api, revision, refresh]);
  const source = useRead(readSource, !!revision);
  const attempts=source.data?.attempts.filter(a=>a.card===card)??[];
  const matching=attempts.filter(a=>runId?a.run_id===runId:a.id===published?.output_id);
  const attempt=matching.find(a=>a.id===published?.output_id)??matching[0];
  const attemptId = attempt?.id;
  const readResult = useCallback(() => api.result(attemptId!), [api, attemptId, refresh]);
  const scores = useRead(readResult, !!attempt && (tab === "flow" || tab === "output"));
  const readOutput = useCallback(() => client.getRun(runId!), [client, runId, refresh]);
  const output = useRead(readOutput, !!runId && tab === "output");
  if (!history.data) return <Feedback query={history} />;
  if (!stage) return <p className={panel}>This workflow has no recorded {cardNames[card]} scorecard.</p>;
  if (execution !== null && !run)
    return (
      <p role="alert" className={panel}>
        Execution #{execution} does not belong to this scorecard run.
      </p>
    );
  const manifest = source.data?.manifest;
  const promptRecords = jobs.length
    ? jobs.map((j) => ({ id: "Job #" + j.id, body: j.prompt }))
    : run
      ? [{ id: "Execution #" + run.id, body: run.prompt }]
      : [];
  const jobsTable = (list: AutoRebalanceJobDetailResponse[]) => (
    <Table
      columns={["Job", "Provider", "Model", "Status", "Runtime", "Cost"]}
      empty="No model jobs were recorded."
      rows={list.map((j) => ({
        key: j.id,
        cells: [
          "#" + j.id,
          j.provider,
          j.model,
          <Status key="status" value={j.status} />,
          elapsed(j.created_at, j.updated_at),
          formatRebalanceCost({ costUsd: j.estimated_cost }, rate),
        ],
      }))}
    />
  );
  const start = run?.created_at ?? stage.started_at,
    end = run?.updated_at ?? stage.completed_at;
  const durationInfo = {
    state: run?.status ?? stage.status,
    startedAt: start,
    endedAt: end,
    lastRunId: runId,
  };
  const workflowUrl = URLs.routes.console.autoRebalanceRunDetail(market, sequence);
  const scoreRows = new Map(scores.data?.rows.map((row) => [row.listing, row]));
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Status value={run?.status ?? stage.status} />
        {runs.length > 0 && (
          <label className="font-medium">
            Execution{" "}
            <select
              className="rounded-lg border bg-white px-2 py-1.5"
              value={runId}
              onChange={(e) => onExecution(Number(e.target.value))}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.status}
                </option>
              ))}
            </select>
          </label>
        )}
        <span>{formatCompactStageTime(start)}</span>
        {revision && <span>Stage 2 #{revision}</span>}
        {attempt && <span>Output #{attempt.id}</span>}
        {tools?.onManage && revision && (
          <button className={button} onClick={() => tools.onManage?.(card, revision, attempt?.id)}>
            Scorecard controls
          </button>
        )}
      </div>
      {published && <p className="text-sm">Available output #{published.output_id} · {published.covered}/{published.expected} {card==="pairwise"?"pairs judged":"stocks scored"} · Stage 4 {published.used_output_id ? `used output #${published.used_output_id} in final #${published.final_id}` : "has no saved reference"}</p>}
      {run && ["failed","partial","cancelled","canceled"].includes(run.status) && jobs.some(j=>j.error_message) && <details className={panel}><summary>Execution #{run.id} diagnostics</summary>{jobs.filter(j=>j.error_message).map(j=><p key={j.id}>Job #{j.id} · {j.error_message}</p>)}</details>}
      {stage.error_message && (!run || (stage.run_id===run.id && !jobs.length)) && (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
          Workflow stage · {stage.error_message}
        </p>
      )}
      {tab === "inputs" && (
        <section className={panel}>
          <h2 className="mb-4 text-lg font-semibold">Saved inputs</h2>
          <Feedback query={source} />
          {manifest ? (
            <>
              <p className="mb-3 text-sm">
                Snapshot #{manifest.snapshot_id} · {formatApiTimestamp(manifest.snapshot_at)} · Swing jobs{" "}
                {manifest.swing_job_ids.map((id) => "#" + id).join(", ") || "—"}
              </p>
              <Table
                columns={["Listing", "Company", "Source", "Held units"]}
                rows={manifest.stocks.map((s) => ({
                  key: s.listing,
                  cells: [s.listing, s.name, s.origin, s.units ?? "—"],
                }))}
                empty="No listings in the saved inputs."
              />
            </>
          ) : (
            !source.loading && (
              <p className="mb-3 text-sm">
                The saved prompts contain the inputs recorded for this execution.
              </p>
            )
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={button} onClick={() => onTab("prompts")}>
              View saved prompts
            </button>
            {tools?.onInputs && (
              <button className={button} onClick={() => tools.onInputs?.(card)}>
                Configure workflow inputs
              </button>
            )}
          </div>
        </section>
      )}
      {tab === "models" && (
        <section className={panel}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Models used</h2>
            <button className={button} onClick={() => tools?.onModels?.(card)}>
              Choose workflow models
            </button>
          </div>
          {jobsTable(jobs)}
        </section>
      )}
      {tab === "prompts" && (
        <section className="space-y-3 rounded-2xl border border-violet-200 bg-violet-50 p-5">
          <h2 className="text-lg font-semibold">Saved prompts</h2>
          <div className="flex flex-wrap gap-2">
            <button className={button} onClick={() => onTab("inputs")}>
              Review selected inputs
            </button>
            {revision && (
              <button
                className={button}
                aria-expanded={templateOpen}
                onClick={() => setTemplateOpen((open) => !open)}
              >
                Scorecard prompt preview
              </button>
            )}
            {tools?.onTemplate && card !== "pairwise" && (
              <button className={button} onClick={() => tools.onTemplate?.(card)}>
                {revision ? "Legacy prompt template" : "View workflow template"}
              </button>
            )}
          </div>
          {templateOpen && revision && (
            <>
              <Feedback query={template} />
              {template.data && (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs">
                  {template.data.prompt}
                </pre>
              )}
            </>
          )}
          {!promptRecords.length && <p>No prompt was saved for this stage.</p>}
          {promptRecords.map((p) => (
            <details key={p.id} className="rounded-xl bg-slate-950 p-4 text-white">
              <summary className="cursor-pointer text-sm">{p.id} · Raw prompt</summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                {p.body || "No prompt text saved."}
              </pre>
            </details>
          ))}
        </section>
      )}
      {tab === "output" && (
        <section className="min-w-0 space-y-3">
          <Feedback query={output} />
          {output.data && !(market==="zerodha"&&card==="technical") && renderOutput(output.data, card)}
          {!run && (
            <>
              {jobsTable(jobs)}
              {jobs.map((j) => (
                <article className={panel} key={j.id}>
                  <h3 className="font-semibold">
                    {j.provider} · Job #{j.id}
                  </h3>
                  {j.response && card === "pairwise" ? (
                    <StandardLlmOutputRenderer content={j.response} pairwisePrompt={j.prompt ?? ""} />
                  ) : <pre className="mt-3 whitespace-pre-wrap break-words text-sm">
                    {j.response || j.error_message || "No output text saved."}
                  </pre>}
                </article>
              ))}
            </>
          )}
          {card==="pairwise" && scores.data && <PairwiseCoverage result={scores.data}/>}
          {attempt && (
            <details className={panel} open={(card==="technical"||card==="threats")&&market==="zerodha"?true:undefined}>
              <summary className="cursor-pointer font-semibold">
                Saved stock scores · Output #{attempt.id}
              </summary>
              <Feedback query={scores} />
              {scores.data && card==="technical" && market==="zerodha" ? (
                <TechnicalStockScores key={scores.data.id} result={scores.data} onRecover={()=>api.recover(scores.data!.id)} />
              ) : scores.data && card==="threats" && market==="zerodha" ? (
                <ThreatStockScores key={scores.data.id} result={scores.data} onRecover={id=>api.recover(id)} onRetry={revision && jobs[0] ? async id=>{
                  const key=retryKeys.current.get(id)??crypto.randomUUID();
                  retryKeys.current.set(id,key);
                  await api.start(revision,"threats",{sequence,request_key:key,retry_attempt_id:id,
                    targets:[{provider:jobs[0].provider,model:jobs[0].model}]});
                }:undefined} />
              ) : scores.data && (
                <Table
                  columns={["Listing", "Score /100", "Coverage", ...(card==="pairwise"?["W / T / L", "Judged / assigned","Unknown"]:card==="technical"?["Setup","Entry at close","Catalogue rating","5-session return %","20-session relative %","Relative volume","20-session volatility %","Distance to SMA50 %","Research score /100"]:[])]}
                  rows={scores.data.rows.map((r) => ({
                    key: r.listing,
                    cells: [r.listing, r.score == null ? "—" : Number(r.score.toFixed(1)), r.coverage,
                      ...(card==="pairwise"?[`${r.wins??"—"} / ${r.ties??"—"} / ${r.losses??"—"}`,`${r.valid??"—"} / ${r.expected??"—"}`,typeof r.valid==="number"&&typeof r.expected==="number"?r.expected-r.valid:"—"]:card==="technical"?[
                        ...["setup","entry","catalogue_rating"].map(k=>String((r.readiness as Record<string,unknown>)?.[k]??"—")),
                        ...["return_5_pct","relative_20_pct","relative_volume_20","volatility_20_pct","distance_sma50_pct","shadow_score"].map(k=>{const v=(r.features as Record<string,unknown>)?.[k];return typeof v==="number"?v.toFixed(2):"—";})
                      ]:[])],
                  }))}
                  empty="No scores recorded."
                />
              )}
            </details>
          )}
          {card==="technical"&&market==="zerodha"&&<><TechnicalValidation key={sequence} read={api.technicalValidation} executions={api.technicalExecutions}/>
            {output.data&&<details className={panel}><summary>Original model output</summary>{renderOutput(output.data,card)}</details>}</>}
        </section>
      )}
      {tab === "duration" && (
        <section className="space-y-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
          <h2 className="text-lg font-semibold">Duration breakdown</h2>
          <p className="font-mono text-3xl font-semibold">{elapsed(start, end)}</p>
          <p className="text-sm">
            {formatApiTimestamp(start)} → {formatApiTimestamp(end)}
          </p>
          {jobsTable(jobs)}
          <button className={button} onClick={() => setDurationOpen(true)}>
            Open duration breakdown
          </button>
          <StageDurationBreakdownDialog
            open={durationOpen}
            stageLabel={cardNames[card]}
            info={durationInfo}
            now={Date.now()}
            onClose={() => setDurationOpen(false)}
          />
        </section>
      )}
      {tab === "flow" && (
        <section className={panel}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Stock Flow · Run #{sequence}</h2>
            <button className={button} onClick={tools?.onStockFlow}>
              Open portfolio Stock Flow
            </button>
          </div>
          <Feedback query={source} />
          <Feedback query={scores} />
          {manifest ? (
            <Table
              columns={[
                "Stage 2 listing",
                "Source",
                "Held units",
                cardNames[card] + " score /100",
                "Coverage",
              ]}
              rows={manifest.stocks.map((s) => ({
                key: s.listing,
                cells: [
                  s.listing,
                  s.origin,
                  s.units ?? "—",
                  scoreRows.get(s.listing)?.score ?? "—",
                  scoreRows.get(s.listing)?.coverage ?? "—",
                ],
              }))}
              empty="No Stage 2 listings."
            />
          ) : (
            !source.loading && (
              <p className="text-sm">
                This execution has no published Stage 2 listing table.{" "}
                <button className="text-indigo-700 underline" onClick={() => onTab("output")}>
                  View saved stock output
                </button>
              </p>
            )
          )}
        </section>
      )}
      {tab === "history" && (
        <section className={panel}>
          <h2 className="mb-4 text-lg font-semibold">Executions for Run #{sequence}</h2>
          <Table
            columns={["Execution", "Started", "Status", "Jobs"]}
            rows={runs.map((r) => ({
              key: r.id,
              cells: [
                <button key="run" className="text-indigo-700 underline" onClick={() => onExecution(r.id)}>
                  #{r.id}
                </button>,
                formatCompactStageTime(r.created_at),
                <Status key="s" value={r.status} />,
                r.jobs.length,
              ],
            }))}
            empty="No linked executions."
          />
          {!!standalone.length && jobsTable(standalone)}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className={button} href={scorecardHref(market, card)}>
              All {title(card)}
            </Link>
            <Link className={button} href={workflowUrl}>
              Full workflow history
            </Link>
          </div>
        </section>
      )}
      {tab === "account" && (
        <section className={panel}>
          <h2 className="mb-4 text-lg font-semibold">{account}</h2>
          <Table
            columns={["Portfolio", "Workflow", "Scorecard", "Execution"]}
            rows={[
              {
                key: "owner",
                cells: [brokerName(market), "#" + sequence, cardNames[card], runId ? "#" + runId : "—"],
              },
            ]}
            empty=""
          />
        </section>
      )}
    </div>
  );
}

export function ScorecardScreen({
  market,
  screen,
  client,
  account,
  renderOutput,
  ...tools
}: Base & Tools & { screen: ScorecardPath; account: string }) {
  const query = useSearchParams();
  const router = useRouter();
  const { card, sequence } = screen;
  const tabValue = query.get("tab") ?? "output";
  const tab = Object.hasOwn(scorecardTabs, tabValue) ? (tabValue as ScorecardTab) : "output";
  const execution = query.has("execution") ? Number(query.get("execution")) : null;
  const here = card ? title(card) + (sequence ? " Run #" + sequence : "") : "Scorecards";
  const href = (next: ScorecardTab, id = execution) => scorecardHref(market, card, sequence, next, id);
  return (
    <main className="mx-auto min-w-0 max-w-[100rem] space-y-5 p-3 pb-10 md:p-6">
      <nav
        aria-label="Scorecard breadcrumbs"
        className="flex flex-wrap items-center gap-2 text-sm text-slate-600"
      >
        {card ? (
          <Link href={scorecardHref(market)} className="text-indigo-700 underline">
            Scorecards
          </Link>
        ) : (
          <span aria-current="page">Scorecards</span>
        )}
        {card && (
          <>
            <span aria-hidden="true">›</span>
            {sequence ? (
              <Link href={scorecardHref(market, card)} className="text-indigo-700 underline">
                {title(card)}
              </Link>
            ) : (
              <span aria-current="page">{title(card)}</span>
            )}
          </>
        )}
        {sequence && (
          <>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{here}</span>
          </>
        )}
      </nav>
      <header
        className={
          "rounded-2xl border p-5 " + (card ? tones[card] : "border-indigo-200 bg-indigo-50 text-indigo-950")
        }
      >
        <Link
          href={market === "zerodha" ? "/console/zerodha" : "/console/indmoney-us"}
          className="text-sm underline"
        >
          {brokerName(market)}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{here}</h1>
      </header>
      {card && sequence ? (
        <>
          <nav aria-label="Scorecard sections" className="flex flex-wrap gap-2">
            {(Object.keys(scorecardTabs) as ScorecardTab[]).map((k) => (
              <Link
                key={k}
                scroll={false}
                href={href(k)}
                aria-current={tab === k ? "page" : undefined}
                className={
                  "rounded-full px-4 py-2 text-sm font-semibold " +
                  (tab === k
                    ? "bg-indigo-700 text-white"
                    : "bg-indigo-50 text-indigo-800 hover:bg-indigo-100")
                }
              >
                {k === "account" ? account : scorecardTabs[k]}
              </Link>
            ))}
          </nav>
          <Evidence
            market={market}
            card={card}
            sequence={sequence}
            tab={tab}
            execution={execution}
            client={client}
            account={account}
            tools={tools}
            renderOutput={renderOutput}
            onTab={(t) => router.push(href(t), { scroll: false })}
            onExecution={(id) => router.push(href(tab, id), { scroll: false })}
          />
        </>
      ) : (
        <Catalogue market={market} card={card} client={client} />
      )}
    </main>
  );
}

export function ScorecardEvidenceDialog({
  market,
  client,
  card,
  sequence,
  tab: initialTab,
  onClose,
  onInputs,
  onTemplate,
  renderOutput,
}: Base & {
  card: CardKey;
  sequence: number;
  tab: ScorecardTab;
  onClose: () => void;
  onInputs: () => void;
  onTemplate?: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [execution, setExecution] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const promptDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = promptDialog.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [initialTab]);
  const body = (
    <Evidence
      market={market}
      client={client}
      card={card}
      sequence={sequence}
      tab={tab}
      execution={execution}
      refresh={refresh}
      renderOutput={renderOutput}
      onTab={setTab}
      onExecution={setExecution}
      tools={{ onInputs, onTemplate }}
    />
  );
  if (initialTab !== "output")
    return (
      <dialog
        ref={promptDialog}
        onCancel={onClose}
        aria-label={cardNames[card] + " " + scorecardTabs[tab]}
        className="m-auto max-h-[85dvh] w-[min(95vw,90rem)] max-w-none overflow-auto rounded-3xl border border-violet-200 bg-violet-50 p-5 text-slate-900 shadow-2xl backdrop:bg-slate-950/50"
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-violet-700">Run #{sequence}</p>
            <h2 className="mt-1 text-lg font-semibold">
              {brokerName(market)} · {cardNames[card]} {scorecardTabs[tab]}
            </h2>
          </div>
          <button onClick={onClose} className={button}>
            Close
          </button>
        </header>
        {body}
        <footer className="mt-4 flex flex-wrap gap-4 text-sm">
          <a
            href={scorecardHref(market, card, sequence, tab, execution)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-800 underline"
          >
            Open stage page in new tab
          </a>
          <button onClick={() => setRefresh((n) => n + 1)} className="text-violet-800 underline">
            Refresh
          </button>
        </footer>
      </dialog>
    );
  return (
    <SavedOutputDialog
      title={brokerName(market) + " · " + cardNames[card] + " " + scorecardTabs[tab]}
      routeUrl={scorecardHref(market, card, sequence, tab, execution)}
      sectionLabel={scorecardTabs[tab]}
      provenance={"Workflow Run #" + sequence}
      onClose={onClose}
      onRetry={() => setRefresh((n) => n + 1)}
      loading={false}
    >
      <div className="space-y-3 bg-white p-4">{body}</div>
    </SavedOutputDialog>
  );
}
