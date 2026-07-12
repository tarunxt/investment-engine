import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveDecisionAction,
  BullpenAutoLiveGuardrailCheck,
  BullpenAutoLiveRun,
  BullpenAutoLiveSettings,
  BullpenAutoLiveStageResult,
  BullpenAutoLiveState,
} from "@/types/api";

export type AutoLiveDecisionFilterKey =
  | "all"
  | "buy-add"
  | "hold"
  | "trim-exit"
  | "skipped"
  | "blocked"
  | "executed"
  | "high-disagreement"
  | "low-evidence"
  | "deadline-risk";

export type AutoLiveDecisionSortKey =
  | "highest-edge"
  | "highest-score"
  | "largest-exposure"
  | "nearest-deadline"
  | "latest-updated";

export type AutoLiveDecisionStatusLabel =
  | "BLOCKED"
  | "DRY-RUN"
  | "EXECUTED"
  | "SKIP";

export type AutoLiveDecisionSectionValue = {
  label: string;
  value: string | number | boolean | string[] | null;
};

export type AutoLiveDecisionSection = {
  values: AutoLiveDecisionSectionValue[];
};

export type AutoLiveTimelineStage = {
  stageNumber: number;
  label: string;
  status: BullpenAutoLiveStageResult["status"];
  reason: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  hardBlock: boolean;
  guardrailsChecked: BullpenAutoLiveGuardrailCheck[];
};

export type AutoLiveDecisionRowView = {
  id: string;
  decision: BullpenAutoLiveDecision;
  deadlineEt: string | null;
  hoursRemaining: number | null;
  currentPriceCents: number | null;
  fairProbabilityPct: number | null;
  marketOddsLabel: string;
  proposedOrderUsd: number;
  proposedOrderLabel: string;
  statusLabel: AutoLiveDecisionStatusLabel;
  blocked: boolean;
  executed: boolean;
  failed: boolean;
  dryRun: boolean;
  highDisagreement: boolean;
  lowEvidence: boolean;
  deadlineRisk: boolean;
  marketRules: AutoLiveDecisionSection;
  evidence: AutoLiveDecisionSection;
  llmConsensus: AutoLiveDecisionSection;
  scoreCalculation: AutoLiveDecisionSection;
  sizingCalculation: AutoLiveDecisionSection;
  rebalanceDecision: AutoLiveDecisionSection;
  execution: AutoLiveDecisionSection;
  timeline: AutoLiveTimelineStage[];
};

export type AutoLiveGuardrailFailureSummary = {
  category: string;
  count: number;
};

export type AutoLiveRunSummaryView = {
  marketsScanned: number;
  marketsRejected: number;
  candidatesPassed: number;
  actionCounts: Record<BullpenAutoLiveDecisionAction, number>;
  executedCount: number;
  failedCount: number;
  totalProposedExposureUsd: number;
  totalExecutedExposureUsd: number;
  remainingCashReserveUsd: number | null;
  maxThemeExposureUsed: {
    theme: string | null;
    exposureUsd: number;
    pctBankroll: number | null;
  };
  guardrailFailures: AutoLiveGuardrailFailureSummary[];
};

export const AUTO_LIVE_TIMELINE_LABELS = [
  "Candidate Scan",
  "Rules & Deadline",
  "Evidence + LLM",
  "Scoring",
  "Sizing",
  "Rebalance",
  "Execution",
] as const;

const FILTER_LABELS: Record<AutoLiveDecisionFilterKey, string> = {
  all: "All",
  "buy-add": "Buy/Add",
  hold: "Hold",
  "trim-exit": "Trim/Exit",
  skipped: "Skipped",
  blocked: "Blocked",
  executed: "Executed",
  "high-disagreement": "High disagreement",
  "low-evidence": "Low evidence",
  "deadline-risk": "Deadline risk",
};

const SORT_LABELS: Record<AutoLiveDecisionSortKey, string> = {
  "highest-edge": "Highest edge",
  "highest-score": "Highest score",
  "largest-exposure": "Largest exposure",
  "nearest-deadline": "Nearest deadline",
  "latest-updated": "Latest updated",
};

export function toggleAutoLiveDecisionRow(openRowIds: string[], rowId: string) {
  return openRowIds.includes(rowId)
    ? openRowIds.filter((id) => id !== rowId)
    : [...openRowIds, rowId];
}

export function getEffectiveOpenAutoLiveDecisionRowIds(
  visibleRowIds: string[],
  openRowIds: string[],
) {
  const visibleRowIdSet = new Set(visibleRowIds);
  const visibleOpenRowIds = openRowIds.filter((id) => visibleRowIdSet.has(id));
  if (visibleOpenRowIds.length > 0) {
    return visibleOpenRowIds;
  }
  return visibleRowIds.length > 0 ? [visibleRowIds[0]] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStageOutput(stage: BullpenAutoLiveStageResult | null, key: string) {
  if (!stage || !isRecord(stage.outputs)) return undefined;
  return stage.outputs[key];
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function collectStageByNumber(
  stageResults: BullpenAutoLiveStageResult[],
): Map<number, BullpenAutoLiveStageResult> {
  const map = new Map<number, BullpenAutoLiveStageResult>();
  for (const stage of stageResults) {
    map.set(stage.stage_number, stage);
  }
  return map;
}

function summarizeMarketOdds(decision: BullpenAutoLiveDecision) {
  const yes = readNumber(decision.current_yes_odds);
  const no = readNumber(decision.current_no_odds);
  if (yes === null && no === null) return "-";
  if (yes !== null && no !== null) {
    return `YES ${yes.toFixed(1)}% / NO ${no.toFixed(1)}%`;
  }
  if (yes !== null) return `YES ${yes.toFixed(1)}%`;
  return `NO ${no?.toFixed(1)}%`;
}

function extractProposedOrderUsd(
  decision: BullpenAutoLiveDecision,
  stage6: BullpenAutoLiveStageResult | null,
) {
  return (
    readNumber(decision.order_plan?.order_size_usd) ??
    readNumber(readStageOutput(stage6, "order_usd")) ??
    0
  );
}

function buildProposedOrderLabel(
  decision: BullpenAutoLiveDecision,
  stage6: BullpenAutoLiveStageResult | null,
) {
  const orderPlan = decision.order_plan;
  if (orderPlan) {
    const action = orderPlan.action === "buy" ? "Buy" : orderPlan.action === "sell" ? "Sell" : orderPlan.action === "redeem" ? "Redeem" : "Hold";
    return `${action} ${orderPlan.side} ${orderPlan.order_size_usd.toFixed(2)} @ ${orderPlan.limit_price_cents.toFixed(1)}c`;
  }

  const orderUsd = extractProposedOrderUsd(decision, stage6);
  if (decision.decision === "HOLD" || orderUsd <= 0) {
    return decision.decision === "SKIP" ? "Blocked" : "No change";
  }

  const action = decision.decision === "TRIM" || decision.decision === "EXIT" ? "Sell" : "Buy";
  return `${action} ${decision.side} ${orderUsd.toFixed(2)}`;
}

function deriveStatusLabel(
  decision: BullpenAutoLiveDecision,
  stage7: BullpenAutoLiveStageResult | null,
  defaultDryRun: boolean,
): AutoLiveDecisionStatusLabel {
  if (
    decision.order_plan?.status === "submitted" ||
    decision.order_plan?.status === "confirmed"
  ) {
    return "EXECUTED";
  }

  if (
    decision.order_plan?.status === "failed" ||
    stage7?.status === "fail" ||
    decision.risk_status === "Blocked"
  ) {
    return "BLOCKED";
  }

  if (decision.order_plan?.dry_run || defaultDryRun) {
    return "DRY-RUN";
  }

  return "SKIP";
}

function deriveDeadlineRisk(
  hoursRemaining: number | null,
  settings: BullpenAutoLiveSettings | null,
) {
  if (hoursRemaining === null || !settings) return false;
  return (
    hoursRemaining <= settings.no_new_trade_under_hours_to_deadline ||
    hoursRemaining <= settings.half_size_under_hours_to_deadline
  );
}

function categorizeFailure(label: string, detail: string) {
  const haystack = `${label} ${detail}`.toLowerCase();

  if (haystack.includes("doctor")) return "Doctor";
  if (haystack.includes("balance")) return "Balance";
  if (haystack.includes("deadline")) return "Deadline";
  if (haystack.includes("slippage")) return "Slippage";
  if (haystack.includes("spread")) return "Spread";
  if (haystack.includes("liquidity")) return "Liquidity";
  if (haystack.includes("adjudication")) return "Adjudication";
  if (haystack.includes("confidence")) return "Confidence";
  if (haystack.includes("evidence")) return "Evidence";
  if (haystack.includes("score")) return "Score";
  if (haystack.includes("edge")) return "Edge";
  if (haystack.includes("daily loss")) return "Daily loss stop";
  if (haystack.includes("weekly loss")) return "Weekly loss stop";
  if (haystack.includes("llm")) return "LLM disagreement";
  if (haystack.includes("emergency stop")) return "Emergency stop";
  if (haystack.includes("order") && haystack.includes("minimum")) return "Order size";
  if (haystack.includes("max active market")) return "Market limit";
  if (haystack.includes("candidate block")) return "Candidate block";

  return label;
}

function buildFailureSummary(
  decisions: BullpenAutoLiveDecision[],
  run: BullpenAutoLiveRun | null,
) {
  const counts = new Map<string, number>();

  const addFailure = (label: string, detail: string) => {
    const category = categorizeFailure(label, detail);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  };

  for (const check of run?.guardrail_checks ?? []) {
    if (check.status === "fail" || check.blocking) {
      addFailure(check.label, check.detail);
    }
  }

  for (const decision of decisions) {
    for (const check of decision.guardrail_checks) {
      if (check.status === "fail" || check.blocking) {
        addFailure(check.label, check.detail);
      }
    }
    const stage7 = decision.stage_results.find((stage) => stage.stage_number === 7) ?? null;
    if (stage7?.status === "fail") {
      addFailure(stage7.stage_name, stage7.reason);
    }
  }

  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}

function buildTimeline(
  decision: BullpenAutoLiveDecision,
  stageMap: Map<number, BullpenAutoLiveStageResult>,
) {
  return AUTO_LIVE_TIMELINE_LABELS.map((label, index) => {
    const stageNumber = index + 1;
    const stage = stageMap.get(stageNumber) ?? null;
    return {
      stageNumber,
      label,
      status: stage?.status ?? "skipped",
      reason: stage?.reason ?? "No stage data was persisted.",
      inputs: isRecord(stage?.inputs) ? stage.inputs : {},
      outputs: isRecord(stage?.outputs) ? stage.outputs : {},
      hardBlock: stage?.hard_block ?? false,
      guardrailsChecked: stage?.guardrails_checked ?? [],
    } satisfies AutoLiveTimelineStage;
  });
}

function buildHardCapsApplied(
  stage5: BullpenAutoLiveStageResult | null,
) {
  const caps: string[] = [];
  const remainingSingleMarketCapacity = readNumber(
    readStageOutput(stage5, "remaining_single_market_capacity"),
  );
  const remainingThemeCapacity = readNumber(
    readStageOutput(stage5, "remaining_theme_capacity"),
  );
  const remainingOpenExposureCapacity = readNumber(
    readStageOutput(stage5, "remaining_open_exposure_capacity"),
  );
  const remainingCashReserveCapacity = readNumber(
    readStageOutput(stage5, "remaining_cash_reserve_capacity"),
  );

  if (remainingSingleMarketCapacity !== null) {
    caps.push(`Single market cap ${remainingSingleMarketCapacity.toFixed(2)}`);
  }
  if (remainingThemeCapacity !== null) {
    caps.push(`Theme cap ${remainingThemeCapacity.toFixed(2)}`);
  }
  if (remainingOpenExposureCapacity !== null) {
    caps.push(`Open exposure cap ${remainingOpenExposureCapacity.toFixed(2)}`);
  }
  if (remainingCashReserveCapacity !== null) {
    caps.push(`Cash reserve cap ${remainingCashReserveCapacity.toFixed(2)}`);
  }

  return caps.length > 0 ? caps.join(" | ") : null;
}

export function buildAutoLiveDecisionRows({
  decisions,
  settings,
  state,
}: {
  decisions: BullpenAutoLiveDecision[];
  settings: BullpenAutoLiveSettings | null;
  state: BullpenAutoLiveState | null;
}) {
  return decisions.map((decision) => {
    const stageMap = collectStageByNumber(decision.stage_results);
    const stage2 = stageMap.get(2) ?? null;
    const stage3 = stageMap.get(3) ?? null;
    const stage4 = stageMap.get(4) ?? null;
    const stage5 = stageMap.get(5) ?? null;
    const stage6 = stageMap.get(6) ?? null;
    const stage7 = stageMap.get(7) ?? null;

    const deadlineEt = readString(readStageOutput(stage2, "deadline_et"));
    const hoursRemaining =
      readNumber(readStageOutput(stage2, "hours_remaining")) ??
      readNumber(decision.hours_remaining);
    const statusLabel = deriveStatusLabel(decision, stage7, Boolean(state?.dry_run));
    const proposedOrderUsd = extractProposedOrderUsd(decision, stage6);
    const blocked = statusLabel === "BLOCKED";
    const executed = statusLabel === "EXECUTED";
    const failed = stage7?.status === "fail" || decision.order_plan?.status === "failed";
    const dryRun = statusLabel === "DRY-RUN";
    const spread = readNumber(readStageOutput(stage3, "spread_yes"));
    const highDisagreement =
      decision.disagreement_level?.toLowerCase() === "high" ||
      decision.adjudication_required === true;
    const lowEvidence = decision.evidence_status === "Low";
    const deadlineRisk = deriveDeadlineRisk(hoursRemaining, settings);

    const marketRulesNoDefinition =
      "No if the YES condition is not met by the stated deadline.";

    return {
      id: decision.id,
      decision,
      deadlineEt,
      hoursRemaining,
      currentPriceCents: readNumber(decision.price_cents),
      fairProbabilityPct: readNumber(decision.fair_probability_pct),
      marketOddsLabel: summarizeMarketOdds(decision),
      proposedOrderUsd,
      proposedOrderLabel: buildProposedOrderLabel(decision, stage6),
      statusLabel,
      blocked,
      executed,
      failed,
      dryRun,
      highDisagreement,
      lowEvidence,
      deadlineRisk,
      marketRules: {
        values: [
          {
            label: "Yes definition",
            value: readString(readStageOutput(stage2, "yes_definition")),
          },
          {
            label: "No definition",
            value: marketRulesNoDefinition,
          },
          {
            label: "Resolution criteria",
            value: readString(readStageOutput(stage2, "resolution_criteria")),
          },
          {
            label: "Deadline ET",
            value: deadlineEt,
          },
          {
            label: "Hours remaining",
            value: hoursRemaining,
          },
        ],
      },
      evidence: {
        values: [
          { label: "Evidence status", value: decision.evidence_status },
          { label: "Event state", value: decision.event_state ?? null },
          {
            label: "Key evidence bullets",
            value: decision.key_evidence.length > 0 ? decision.key_evidence : null,
          },
          {
            label: "Red flags",
            value: decision.red_flags.length > 0 ? decision.red_flags : null,
          },
        ],
      },
      llmConsensus: {
        values: [
          {
            label: "Average yes",
            value: readNumber(readStageOutput(stage3, "average_yes")),
          },
          {
            label: "Median yes",
            value: readNumber(readStageOutput(stage3, "median_yes")),
          },
          {
            label: "Trimmed mean yes",
            value: readNumber(readStageOutput(stage3, "trimmed_mean_yes")),
          },
          {
            label: "Min yes",
            value: readNumber(readStageOutput(stage3, "min_yes")),
          },
          {
            label: "Max yes",
            value: readNumber(readStageOutput(stage3, "max_yes")),
          },
          {
            label: "Spread",
            value: spread,
          },
          {
            label: "Disagreement level",
            value: decision.disagreement_level ?? null,
          },
          {
            label: "Confidence",
            value: decision.confidence,
          },
          {
            label: "Adjudication required",
            value: readBoolean(readStageOutput(stage3, "adjudication_required")) ??
              decision.adjudication_required,
          },
        ],
      },
      scoreCalculation: {
        values: [
          { label: "Edge", value: readNumber(readStageOutput(stage4, "edge_pp")) ?? decision.edge_pp },
          {
            label: "Evidence weight",
            value: readNumber(readStageOutput(stage4, "evidence_weight")),
          },
          {
            label: "Confidence weight",
            value: readNumber(readStageOutput(stage4, "confidence_weight")),
          },
          {
            label: "Liquidity weight",
            value: readNumber(readStageOutput(stage4, "liquidity_weight")),
          },
          {
            label: "Disagreement weight",
            value: readNumber(readStageOutput(stage4, "disagreement_weight")),
          },
          { label: "Final score", value: readNumber(readStageOutput(stage4, "score")) ?? decision.score },
        ],
      },
      sizingCalculation: {
        values: [
          { label: "Bankroll", value: settings?.bankroll_usd ?? null },
          { label: "Kelly fraction", value: settings?.kelly_fraction ?? null },
          {
            label: "Full Kelly",
            value: readNumber(readStageOutput(stage5, "full_kelly")),
          },
          {
            label: "Safe Kelly",
            value: readNumber(readStageOutput(stage5, "safe_kelly")),
          },
          {
            label: "Hard caps applied",
            value: buildHardCapsApplied(stage5),
          },
          {
            label: "Target exposure",
            value: readNumber(readStageOutput(stage5, "target_usd")) ?? decision.target_exposure_usd,
          },
          {
            label: "Current exposure",
            value:
              readNumber(readStageOutput(stage5, "current_exposure_usd")) ??
              decision.current_exposure_usd,
          },
          { label: "Proposed order", value: proposedOrderUsd },
        ],
      },
      rebalanceDecision: {
        values: [
          { label: "Decision", value: decision.decision },
          { label: "Reason", value: decision.reason },
          {
            label: "Rule that triggered decision",
            value: stage6?.reason ?? decision.reason,
          },
        ],
      },
      execution: {
        values: [
          { label: "Dry-run or live", value: decision.order_plan?.dry_run || state?.dry_run ? "Dry-run" : "Live" },
          { label: "Doctor status", value: state?.doctor_status ?? null },
          { label: "Balance status", value: state?.balance_status ?? null },
          {
            label: "Orderbook/spread check",
            value: stage7?.reason ?? decision.order_plan?.detail ?? null,
          },
          {
            label: "Limit price",
            value: readNumber(decision.order_plan?.limit_price_cents),
          },
          {
            label: "Slippage limit",
            value:
              readNumber(decision.order_plan?.max_slippage_cents) ??
              settings?.max_slippage_cents ??
              null,
          },
          {
            label: "Execution result",
            value: decision.order_plan?.detail ?? stage7?.reason ?? null,
          },
          {
            label: "Transaction / order reference",
            value: decision.order_plan?.execution_response ?? null,
          },
        ],
      },
      timeline: buildTimeline(decision, stageMap),
    } satisfies AutoLiveDecisionRowView;
  });
}

export function buildAutoLiveRunSummary({
  decisions,
  run,
  settings,
}: {
  decisions: BullpenAutoLiveDecision[];
  run: BullpenAutoLiveRun | null;
  settings: BullpenAutoLiveSettings | null;
}): AutoLiveRunSummaryView {
  const defaultCounts: Record<BullpenAutoLiveDecisionAction, number> = {
    BUY_NEW: 0,
    ADD_MORE: 0,
    HOLD: 0,
    TRIM: 0,
    EXIT: 0,
    SKIP: 0,
  };
  const actionCounts = { ...defaultCounts };

  let executedCount = 0;
  let failedCount = 0;
  let totalProposedExposureUsd = 0;
  let totalExecutedExposureUsd = 0;
  const themeExposure = new Map<string, number>();

  for (const decision of decisions) {
    actionCounts[decision.decision] += 1;
    const stage6 = decision.stage_results.find((stage) => stage.stage_number === 6) ?? null;
    const proposedOrderUsd = extractProposedOrderUsd(decision, stage6);
    totalProposedExposureUsd += proposedOrderUsd;
    if (
      decision.order_plan?.status === "submitted" ||
      decision.order_plan?.status === "confirmed"
    ) {
      executedCount += 1;
      totalExecutedExposureUsd += decision.order_plan.order_size_usd;
    }
    const stage7 = decision.stage_results.find((stage) => stage.stage_number === 7) ?? null;
    if (decision.order_plan?.status === "failed" || stage7?.status === "fail") {
      failedCount += 1;
    }
    if (decision.target_exposure_usd > 0) {
      themeExposure.set(
        decision.theme,
        (themeExposure.get(decision.theme) ?? 0) + decision.target_exposure_usd,
      );
    }
  }

  const stage1 = run?.stage_results.find((stage) => stage.stage_number === 1) ?? null;
  const acceptedCandidates = Array.isArray(readStageOutput(stage1, "accepted_candidates"))
    ? (readStageOutput(stage1, "accepted_candidates") as unknown[])
    : [];
  const rejectedCandidates = Array.isArray(readStageOutput(stage1, "rejected_candidates"))
    ? (readStageOutput(stage1, "rejected_candidates") as unknown[])
    : [];
  const candidatesPassed = acceptedCandidates.length || decisions.length;
  const marketsRejected = rejectedCandidates.length;
  const marketsScanned = candidatesPassed + marketsRejected;

  let maxTheme = {
    theme: null as string | null,
    exposureUsd: 0,
    pctBankroll: null as number | null,
  };
  for (const [theme, exposureUsd] of themeExposure.entries()) {
    if (exposureUsd <= maxTheme.exposureUsd) continue;
    maxTheme = {
      theme,
      exposureUsd,
      pctBankroll:
        settings && settings.bankroll_usd > 0
          ? (exposureUsd / settings.bankroll_usd) * 100
          : null,
    };
  }

  const totalTargetExposureUsd = decisions.reduce(
    (total, decision) => total + Math.max(0, decision.target_exposure_usd),
    0,
  );
  const remainingCashReserveUsd = settings
    ? Math.max(0, settings.bankroll_usd - totalTargetExposureUsd)
    : null;

  return {
    marketsScanned,
    marketsRejected,
    candidatesPassed,
    actionCounts,
    executedCount,
    failedCount,
    totalProposedExposureUsd,
    totalExecutedExposureUsd,
    remainingCashReserveUsd,
    maxThemeExposureUsed: maxTheme,
    guardrailFailures: buildFailureSummary(decisions, run),
  };
}

export function filterAutoLiveDecisionRows(
  rows: AutoLiveDecisionRowView[],
  filterKey: AutoLiveDecisionFilterKey,
) {
  return rows.filter((row) => {
    switch (filterKey) {
      case "buy-add":
        return row.decision.decision === "BUY_NEW" || row.decision.decision === "ADD_MORE";
      case "hold":
        return row.decision.decision === "HOLD";
      case "trim-exit":
        return row.decision.decision === "TRIM" || row.decision.decision === "EXIT";
      case "skipped":
        return row.decision.decision === "SKIP";
      case "blocked":
        return row.blocked;
      case "executed":
        return row.executed;
      case "high-disagreement":
        return row.highDisagreement;
      case "low-evidence":
        return row.lowEvidence;
      case "deadline-risk":
        return row.deadlineRisk;
      case "all":
      default:
        return true;
    }
  });
}

export function sortAutoLiveDecisionRows(
  rows: AutoLiveDecisionRowView[],
  sortKey: AutoLiveDecisionSortKey,
) {
  const sortedRows = [...rows];
  sortedRows.sort((left, right) => {
    if (sortKey === "highest-edge") {
      return right.decision.edge_pp - left.decision.edge_pp;
    }
    if (sortKey === "highest-score") {
      return right.decision.score - left.decision.score;
    }
    if (sortKey === "largest-exposure") {
      const leftExposure = Math.max(left.decision.current_exposure_usd, left.decision.target_exposure_usd);
      const rightExposure = Math.max(
        right.decision.current_exposure_usd,
        right.decision.target_exposure_usd,
      );
      return rightExposure - leftExposure;
    }
    if (sortKey === "nearest-deadline") {
      if (left.hoursRemaining === null && right.hoursRemaining === null) return 0;
      if (left.hoursRemaining === null) return 1;
      if (right.hoursRemaining === null) return -1;
      return left.hoursRemaining - right.hoursRemaining;
    }

    const leftUpdated = Date.parse(left.decision.updated_at);
    const rightUpdated = Date.parse(right.decision.updated_at);
    return rightUpdated - leftUpdated;
  });
  return sortedRows;
}

export function getAutoLiveFilterLabel(filterKey: AutoLiveDecisionFilterKey) {
  return FILTER_LABELS[filterKey];
}

export function getAutoLiveSortLabel(sortKey: AutoLiveDecisionSortKey) {
  return SORT_LABELS[sortKey];
}
