"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { formatUnknownError } from "@/lib/apiErrors";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type {
  Bullpen008HistoryPage,
  Bullpen008Run,
  BullpenAutoLiveHistoryItem,
  BullpenAutoLiveHistoryPage,
} from "@/types/api";
import { BullpenHistoryPortfolio } from "../../bullpen-ai/_components/BullpenHistoryPortfolio";
import { BullpenRunHistoryContent } from "../../bullpen-ai/_components/BullpenRunHistoryContent";

const PAGE_SIZE = 20;

function asHistoryItem(run: Bullpen008Run): BullpenAutoLiveHistoryItem {
  const started = new Date(run.started_at).getTime();
  const completed = run.completed_at ? new Date(run.completed_at).getTime() : null;
  const durationSeconds =
    Number.isFinite(started) && completed !== null && Number.isFinite(completed)
      ? Math.max(0, (completed - started) / 1000)
      : null;
  return {
    id: run.id,
    triggered_by: run.triggered_by,
    status: run.status,
    dry_run: run.shadow_mode,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_seconds: durationSeconds,
    summary: run.summary,
    error_message: run.error_message,
    decisions_count: Number(run.run_metadata.decisions_count ?? 0),
    orders_planned: Number(run.run_metadata.orders_created ?? 0),
    orders_submitted: Number(run.run_metadata.orders_submitted ?? 0),
    order_funnel: {} as BullpenAutoLiveHistoryItem["order_funnel"],
    stages: run.stages.map((stage) => ({
      key: `stage${stage.stage_number}`,
      stage_number: stage.stage_number,
      label: `Stage ${stage.stage_number}`,
      status: stage.status,
      phase_status: stage.block_reason,
      started_at: stage.started_at,
      completed_at: stage.completed_at,
      blocker_preview: stage.block_reason,
    })),
    blocker_preview: run.error_message,
    latest_update_at: run.completed_at ?? run.started_at,
    projection_available: true,
  } as unknown as BullpenAutoLiveHistoryItem;
}

function asHistoryPage(
  response: Bullpen008HistoryPage,
  pageNumber: number,
): BullpenAutoLiveHistoryPage {
  const pages = Math.ceil(response.total / PAGE_SIZE);
  return {
    items: response.rows.map(asHistoryItem),
    total: response.total,
    page: pageNumber,
    size: PAGE_SIZE,
    pages,
    has_next: pageNumber < pages,
    generated_at: new Date().toISOString(),
  };
}

export function Bullpen008RunHistoryScreen() {
  const router = useRouter();
  const [page, setPage] = useState<BullpenAutoLiveHistoryPage | null>(null);
  const [trends, setTrends] = useState<Awaited<
    ReturnType<typeof apiService.getBullpen008HistoryEventTrends>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [portfolioReady, setPortfolioReady] = useState(false);
  const [portfolioVersion, setPortfolioVersion] = useState(0);

  const load = useCallback(async (pageNumber = 1) => {
    setLoading(true);
    setError(null);
    setTrendsError(null);
    const options = { timeoutMs: 15_000 };
    const [historyResult, trendsResult] = await Promise.allSettled([
      apiService.getBullpen008Runs(
        { limit: PAGE_SIZE, offset: (pageNumber - 1) * PAGE_SIZE },
        options,
      ),
      apiService.getBullpen008HistoryEventTrends(options),
    ]);
    if (historyResult.status === "fulfilled") {
      setPage(asHistoryPage(historyResult.value, pageNumber));
    } else {
      setError(
        `Bullpen 008 run history is temporarily unavailable. ${formatUnknownError(historyResult.reason)}`,
      );
    }
    if (trendsResult.status === "fulfilled") {
      setTrends(trendsResult.value);
    } else {
      setTrendsError(
        `Bullpen 008 event trends are temporarily unavailable. ${formatUnknownError(trendsResult.reason)}`,
      );
    }
    setPortfolioVersion((version) => version + 1);
    setPortfolioReady(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => void load());
  }, [load]);

  const loadReturnsFormula = useCallback(
    async () => (await apiService.getBullpen008Settings()).returns_per_day_formula,
    [],
  );
  const saveReturnsFormula = useCallback(async (formula: string) => {
    const settings = await apiService.updateBullpen008Settings({
      returns_per_day_formula: formula,
    });
    return settings.returns_per_day_formula;
  }, []);

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-8">
      <div className="mx-auto max-w-[96rem] space-y-6">
        {portfolioReady ? (
          <BullpenHistoryPortfolio key={portfolioVersion} />
        ) : (
          <div className="rounded-3xl border border-slate-800 bg-slate-950 px-6 py-8 text-sm font-semibold text-slate-300 shadow-xl">
            Refreshing current Bullpen portfolio…
          </div>
        )}
        <BullpenRunHistoryContent
          page={page}
          trends={trends}
          loading={loading}
          trendsLoading={loading}
          error={error}
          trendsError={trendsError}
          onRefresh={() => void load(page?.page ?? 1)}
          onPage={(next) => void load(next)}
          onOpenRun={(run) =>
            router.push(URLs.routes.console.bullpen008RunDetail(run.id))
          }
          showFullScreen={false}
          eyebrow="Bullpen 008 Run History"
          title="Bullpen 008 Shadow Runs"
          fullScreenPath={URLs.routes.console.bullpen008History()}
          loadReturnsFormula={loadReturnsFormula}
          saveReturnsFormula={saveReturnsFormula}
        />
      </div>
    </main>
  );
}
