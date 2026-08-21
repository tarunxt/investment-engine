import type { BullpenAutoLiveOrderPlan } from "@/types/api";

export type BullpenStage3SellExecutionTelemetry = {
  label: "Primary market sell" | "Fallback 2/3" | "Fallback 3/3";
  reason: string | null;
  sequence: 1 | 2 | 3;
};

const EXECUTION_PATH_SEQUENCE: Record<string, 1 | 2 | 3> = {
  market_sell_explicit: 1,
  primary: 1,
  primary_market_sell: 1,
  market_sell_max: 2,
  secondary: 2,
  fallback_2: 2,
  limit_sell_fak: 3,
  tertiary: 3,
  fallback_3: 3,
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSequence(value: unknown): 1 | 2 | 3 | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return numericValue === 1 || numericValue === 2 || numericValue === 3
    ? numericValue
    : null;
}

function readHistorySequence(row: Record<string, unknown>): 1 | 2 | 3 | null {
  const explicitSequence = readSequence(row.sequence);
  if (explicitSequence) return explicitSequence;

  const layer = readNonEmptyString(row.layer)?.toLowerCase();
  if (!layer) return null;
  return (
    readSequence(layer) ??
    EXECUTION_PATH_SEQUENCE[layer] ??
    (layer.includes("primary")
      ? 1
      : layer.includes("secondary")
        ? 2
        : layer.includes("tertiary")
          ? 3
          : null)
  );
}

function readHistoryReason(row: Record<string, unknown>): string | null {
  return (
    readNonEmptyString(row.reason) ??
    readNonEmptyString(row.validation) ??
    readNonEmptyString(row.reason_code)
  );
}

function historyResultUsedFallback(row: Record<string, unknown>) {
  const result = (
    readNonEmptyString(row.result) ??
    readNonEmptyString(row.status) ??
    ""
  ).toLowerCase();
  return ![
    "accepted",
    "success",
    "succeeded",
    "submitted",
    "filled",
    "valid",
  ].includes(result);
}

function executionPathSequence(path: string): 1 | 2 | 3 | null {
  const normalized = path.trim().toLowerCase();
  return (
    EXECUTION_PATH_SEQUENCE[normalized] ??
    (normalized.includes("primary")
      ? 1
      : normalized.includes("secondary") || normalized.includes("fallback_2")
        ? 2
        : normalized.includes("tertiary") || normalized.includes("fallback_3")
          ? 3
          : null)
  );
}

export function getBullpenStage3SellExecutionTelemetry(
  orderPlan: BullpenAutoLiveOrderPlan | null | undefined,
): BullpenStage3SellExecutionTelemetry | null {
  if (!orderPlan || orderPlan.action !== "sell") return null;

  const executionPath = readNonEmptyString(orderPlan.execution_path);
  const fallbackHistory = Array.isArray(orderPlan.fallback_history)
    ? orderPlan.fallback_history.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  if (!executionPath && fallbackHistory.length === 0) return null;

  const selectedHistoryRow = [...fallbackHistory].reverse().find((entry) => {
    const historyPath = readNonEmptyString(entry.path);
    return (
      executionPath &&
      historyPath?.toLowerCase() === executionPath.toLowerCase()
    );
  });
  const sequence =
    (executionPath ? executionPathSequence(executionPath) : null) ??
    (selectedHistoryRow ? readHistorySequence(selectedHistoryRow) : null) ??
    readHistorySequence(fallbackHistory.at(-1) ?? {}) ??
    1;

  const fallbackTrigger =
    sequence > 1
      ? [...fallbackHistory].reverse().find((entry) => {
          const entrySequence = readHistorySequence(entry);
          return (
            entrySequence !== null &&
            entrySequence < sequence &&
            historyResultUsedFallback(entry) &&
            readHistoryReason(entry) !== null
          );
        })
      : undefined;
  const reason = fallbackTrigger ? readHistoryReason(fallbackTrigger) : null;

  return {
    label:
      sequence === 1
        ? "Primary market sell"
        : sequence === 2
          ? "Fallback 2/3"
          : "Fallback 3/3",
    reason:
      reason ??
      (sequence > 1 && selectedHistoryRow
        ? readHistoryReason(selectedHistoryRow)
        : null),
    sequence,
  };
}
