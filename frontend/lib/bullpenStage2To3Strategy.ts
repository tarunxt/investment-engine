export type BullpenStage2To3StrategyMetadata = {
  minLlmSideOdds: number;
  maxPositions: number;
  rankingField: string;
  rankingTieBreak: string;
  sizingFormula: string;
};

export type BullpenStage2UniverseStatus = {
  totalEligibleRows: number | null;
  reviewedRows: number | null;
  skippedRows: number | null;
  isComplete: boolean;
  blockerCode: string | null;
  blockerSummary: string | null;
  blockerFix: string | null;
};

export const DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS = 80;
export const DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS = 10;
export const DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_FIELD =
  "returns_per_day";
export const DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_TIE_BREAK = "market_id";
export const DEFAULT_BULLPEN_STAGE2_TO_STAGE3_SIZING_FORMULA =
  "cash_in_hand / (max_positions - occupied_positions)";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

export function mergeBullpenStage2To3StrategyOutputs(
  ...sources: Array<Record<string, unknown> | null | undefined>
) {
  let merged: Record<string, unknown> | null = null;
  let mergedStrategyMetadata: Record<string, unknown> | null = null;
  let mergedUniverseStatus: Record<string, unknown> | null = null;

  for (const source of sources) {
    const record = asRecord(source);
    if (!record) continue;

    merged = {
      ...(merged ?? {}),
      ...record,
    };

    const strategyMetadata = asRecord(record.stage2_strategy_metadata);
    if (strategyMetadata) {
      mergedStrategyMetadata = {
        ...(mergedStrategyMetadata ?? {}),
        ...strategyMetadata,
      };
    }

    const universeStatus = asRecord(record.stage2_universe_status);
    if (universeStatus) {
      mergedUniverseStatus = {
        ...(mergedUniverseStatus ?? {}),
        ...universeStatus,
      };
    }
  }

  if (!merged) return null;

  if (mergedStrategyMetadata) {
    merged.stage2_strategy_metadata = mergedStrategyMetadata;
  }
  if (mergedUniverseStatus) {
    merged.stage2_universe_status = mergedUniverseStatus;
  }

  return merged;
}

export function readBullpenStage2To3StrategyMetadata(
  outputs: Record<string, unknown> | null,
): BullpenStage2To3StrategyMetadata {
  const strategyRecord = asRecord(outputs?.stage2_strategy_metadata) ?? outputs;

  return {
    minLlmSideOdds:
      readNumber(strategyRecord?.min_llm_side_odds) ??
      DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
    maxPositions:
      readNumber(strategyRecord?.max_positions) ??
      DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
    rankingField:
      readString(strategyRecord?.ranking_field) ??
      DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_FIELD,
    rankingTieBreak:
      readString(strategyRecord?.ranking_tie_break) ??
      DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_TIE_BREAK,
    sizingFormula:
      readString(strategyRecord?.sizing_formula) ??
      DEFAULT_BULLPEN_STAGE2_TO_STAGE3_SIZING_FORMULA,
  };
}

export function readBullpenStage2UniverseStatus(
  outputs: Record<string, unknown> | null,
): BullpenStage2UniverseStatus {
  const universeRecord = asRecord(outputs?.stage2_universe_status);
  const totalEligibleRows =
    readNumber(universeRecord?.total_eligible_rows) ??
    readNumber(outputs?.stage2_eligible_rows_total);
  const reviewedRows =
    readNumber(universeRecord?.reviewed_rows) ??
    readNumber(outputs?.stage2_reviewed_rows);
  const skippedRows =
    readNumber(universeRecord?.skipped_rows) ??
    readNumber(outputs?.stage2_skipped_rows);
  const explicitIsComplete =
    readBoolean(universeRecord?.is_complete) ??
    readBoolean(outputs?.stage2_universe_complete);
  const blockerCode =
    readString(universeRecord?.blocker_code) ??
    readString(outputs?.stage2_universe_blocker_code);
  const blockerSummary =
    readString(universeRecord?.blocker_summary) ??
    readString(outputs?.stage2_universe_blocker_summary);
  const blockerFix =
    readString(universeRecord?.blocker_fix) ??
    readString(outputs?.stage2_universe_blocker_fix);

  const inferredIsComplete =
    skippedRows !== null
      ? skippedRows <= 0
      : totalEligibleRows !== null && reviewedRows !== null
        ? reviewedRows >= totalEligibleRows
        : null;

  return {
    totalEligibleRows,
    reviewedRows,
    skippedRows,
    isComplete: inferredIsComplete ?? explicitIsComplete ?? true,
    blockerCode,
    blockerSummary,
    blockerFix,
  };
}

export function hasBullpenQualifiedLlmSide(
  value:
    | {
        llmYesOdds?: number | null;
        llmNoOdds?: number | null;
      }
    | null
    | undefined,
  minLlmSideOdds = DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
) {
  return Boolean(
    (value?.llmYesOdds !== null &&
      value?.llmYesOdds !== undefined &&
      value.llmYesOdds >= minLlmSideOdds) ||
      (value?.llmNoOdds !== null &&
        value?.llmNoOdds !== undefined &&
        value.llmNoOdds >= minLlmSideOdds),
  );
}

export function formatBullpenStage2To3RankingFieldLabel(
  rankingField: string,
) {
  if (rankingField === "returns_per_day") {
    return "returns/day";
  }
  return rankingField.replaceAll("_", " ");
}

export function formatBullpenStage2To3RankingTieBreakLabel(
  rankingTieBreak: string,
) {
  if (rankingTieBreak === "market_id") {
    return "market ID";
  }
  return rankingTieBreak.replaceAll("_", " ");
}

export function formatBullpenStage2To3SizingFormulaLabel(
  maxPositions: number,
) {
  return `Cash in Hand / (${maxPositions} - Occupied Positions)`;
}
