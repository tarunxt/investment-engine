import { apiService } from "@/services/api";
import type { PortfolioAnalysisHistoryItem, PortfolioEventRunRequest } from "@/types/api";

const INSTALL_MARKER = Symbol.for(
  "investment-engine:automated-rebalance-threat-start-recovery",
);
const RECONCILIATION_DELAYS_MS = [0, 750, 1_500, 3_000, 6_000] as const;

type MarkedApiService = typeof apiService & {
  [INSTALL_MARKER]?: boolean;
};

function wait(delayMs: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function matchesAutoRebalanceAnalysis(
  item: PortfolioAnalysisHistoryItem,
  data: PortfolioEventRunRequest | undefined,
) {
  if (
    !data?.auto_rebalance_portfolio ||
    typeof data.auto_rebalance_sequence !== "number"
  ) {
    return false;
  }

  return (
    item.auto_rebalance_portfolio === data.auto_rebalance_portfolio &&
    item.auto_rebalance_sequence === data.auto_rebalance_sequence &&
    (!data.auto_rebalance_label ||
      !item.auto_rebalance_label ||
      item.auto_rebalance_label === data.auto_rebalance_label)
  );
}

function normalizeStartError(error: unknown, label: string) {
  if (error instanceof Error && error.message.trim()) return error;
  const message = String(error ?? "").trim();
  return new Error(
    message && !/^(null|undefined)$/i.test(message)
      ? message
      : `${label} was queued but its start response could not be confirmed. Check the saved scan history and retry only if no matching job appears.`,
  );
}

async function reconcileZerodhaThreatStart(
  data: PortfolioEventRunRequest | undefined,
) {
  for (const delayMs of RECONCILIATION_DELAYS_MS) {
    if (delayMs) await wait(delayMs);
    try {
      const history = await apiService.zerodhaThreatsHistory({ limit: 50 });
      const match = history.history.find((item) =>
        matchesAutoRebalanceAnalysis(item, data),
      );
      if (!match) continue;
      const analysis = await apiService.zerodhaThreatJob(match.job_id);
      if (!analysis.snapshot_date || !analysis.captured_at) continue;
      return {
        job_id: analysis.job_id,
        status: analysis.status,
        provider: analysis.provider,
        model: analysis.model,
        snapshot_date: analysis.snapshot_date,
        captured_at: analysis.captured_at,
        created_at: analysis.created_at,
      };
    } catch {
      // The queueing transaction may still be committing. Continue the bounded
      // reconciliation window before surfacing the original ambiguous failure.
    }
  }
  return null;
}

async function reconcileIndmoneyThreatStart(
  data: PortfolioEventRunRequest | undefined,
) {
  for (const delayMs of RECONCILIATION_DELAYS_MS) {
    if (delayMs) await wait(delayMs);
    try {
      const history = await apiService.indmoneyUsThreatsHistory({ limit: 50 });
      const match = history.history.find((item) =>
        matchesAutoRebalanceAnalysis(item, data),
      );
      if (!match) continue;
      const analysis = await apiService.indmoneyUsThreatJob(match.job_id);
      if (
        analysis.snapshot_id == null ||
        !analysis.snapshot_date ||
        !analysis.captured_at
      ) {
        continue;
      }
      return {
        job_id: analysis.job_id,
        status: analysis.status,
        provider: analysis.provider,
        model: analysis.model,
        snapshot_id: analysis.snapshot_id,
        snapshot_date: analysis.snapshot_date,
        captured_at: analysis.captured_at,
        created_at: analysis.created_at,
      };
    } catch {
      // Keep reconciling while the durable job becomes visible.
    }
  }
  return null;
}

export function installAutomatedRebalanceStartRecovery() {
  const service = apiService as MarkedApiService;
  if (service[INSTALL_MARKER]) return;
  service[INSTALL_MARKER] = true;

  const originalZerodhaRunThreats = apiService.zerodhaRunThreats.bind(apiService);
  const originalIndmoneyRunThreats = apiService.indmoneyUsRunThreats.bind(apiService);

  apiService.zerodhaRunThreats = async (data) => {
    try {
      return await originalZerodhaRunThreats(data);
    } catch (error) {
      const recovered = await reconcileZerodhaThreatStart(data);
      if (recovered) return recovered;
      throw normalizeStartError(error, "Zerodha threats scan");
    }
  };

  apiService.indmoneyUsRunThreats = async (data) => {
    try {
      return await originalIndmoneyRunThreats(data);
    } catch (error) {
      const recovered = await reconcileIndmoneyThreatStart(data);
      if (recovered) return recovered;
      throw normalizeStartError(error, "INDmoney US threats scan");
    }
  };
}
