import type { PaginatedResponse, RunListItem, RunResponse } from '@/types/api';

const SUMMARY_PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 4;

type RunHistoryApi = {
  getRuns(params: { page: number; limit: number; summary: boolean }): Promise<PaginatedResponse<RunListItem>>;
  getRun(id: number): Promise<RunResponse>;
};

/**
 * Preserve the complete history used by input selection, cost and consensus
 * views without requesting a response-budget-limited list of full payloads.
 * A preview is deliberately not a filter: legacy markers and matching input
 * bundles can occur beyond its truncation point or on older summary pages.
 */
export async function loadFullRunHistory(
  api: RunHistoryApi,
  assertCurrentSession: () => void = () => {},
): Promise<RunResponse[]> {
  const runIds = new Set<number>();
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    assertCurrentSession();
    const result = await api.getRuns({ page, limit: SUMMARY_PAGE_SIZE, summary: true });
    assertCurrentSession();
    // Use the first response's history boundary; do not chase newly added pages
    // indefinitely if runs are being created while this read is in progress.
    if (page === 1) pages = result.pages;
    result.items.forEach((run) => runIds.add(run.id));
  }

  const ids = Array.from(runIds);
  const runs: RunResponse[] = [];
  for (let start = 0; start < ids.length; start += DETAIL_CONCURRENCY) {
    assertCurrentSession();
    const batch = await Promise.all(
      ids.slice(start, start + DETAIL_CONCURRENCY).map((id) => api.getRun(id)),
    );
    assertCurrentSession();
    // Any detail failure rejects the whole read. Partial input histories must
    // never be presented as complete consensus counts or cost totals.
    runs.push(...batch);
  }
  return runs;
}
