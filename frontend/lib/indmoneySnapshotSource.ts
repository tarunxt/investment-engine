import type { IndMoneyUsPortfolioOverviewResponse, IndMoneyUsPortfolioSnapshotDetail } from "@/types/api";
import { assertIndmoneyHoldingsSnapshot } from "@/lib/rebalance";

export type ReadIndmoneySnapshot = () => Promise<IndMoneyUsPortfolioOverviewResponse>;

export function sameIndmoneySnapshotSource(
  left: IndMoneyUsPortfolioSnapshotDetail,
  right: IndMoneyUsPortfolioSnapshotDetail,
) {
  return left.id === right.id && left.captured_at === right.captured_at;
}

// Read saved data only. Never substitute workflow history for unavailable source data.
export async function readIndmoneySnapshotSource(
  read: ReadIndmoneySnapshot,
  expected?: IndMoneyUsPortfolioSnapshotDetail,
): Promise<IndMoneyUsPortfolioSnapshotDetail> {
  const { latest } = await read();
  if (!latest || !Number.isSafeInteger(latest.id) || latest.id <= 0 ||
      !latest.captured_at || !Number.isFinite(Date.parse(latest.captured_at))) {
    throw new Error("Saved snapshot identity or capture time is unavailable. Paste a snapshot or retry.");
  }
  assertIndmoneyHoldingsSnapshot(latest);
  if (expected && !sameIndmoneySnapshotSource(expected, latest)) {
    throw new Error("The latest saved snapshot changed. Reopen the snapshot choice and review the new source before continuing.");
  }
  return latest;
}
