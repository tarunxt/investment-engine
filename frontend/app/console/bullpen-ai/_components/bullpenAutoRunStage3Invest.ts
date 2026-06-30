import type {
  BullpenAutoLiveConsoleCandidateInput,
  BullpenAutoLiveLlmOutput,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
} from "@/types/api";

export type BullpenStage3OnlyInvestPlan = {
  request: BullpenAutoLiveRunOnceRequest | null;
  qualifiedCandidateCount: number;
  blockedReason: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

function workflowStageOutputs(
  run: BullpenAutoLiveRun,
  workflowStageKey: string,
): Record<string, unknown> | null {
  for (const stage of run.stage_results) {
    const outputs = asRecord(stage.outputs);
    if (readString(outputs?.workflow_stage_key) === workflowStageKey) {
      return outputs;
    }
  }
  return null;
}

function buildAcceptedCandidateLookup(
  scanOutputs: Record<string, unknown> | null,
): Map<string, Record<string, unknown>> {
  const lookup = new Map<string, Record<string, unknown>>();
  for (const item of asArray(scanOutputs?.accepted_candidates)) {
    const record = asRecord(item);
    const marketId = readString(record?.market_id);
    if (record && marketId) {
      lookup.set(marketId, record);
    }
  }
  return lookup;
}

function buildRulesSummary(reviewedCandidate: Record<string, unknown>): string | null {
  const yesDefinition = readString(reviewedCandidate.yes_definition);
  const deadlineEt = readString(reviewedCandidate.deadline_et);
  const rulesFailReason = readString(reviewedCandidate.rules_fail_reason);

  if (rulesFailReason) {
    return rulesFailReason;
  }

  const parts = [yesDefinition];
  if (deadlineEt) {
    parts.push(`Deadline ET: ${deadlineEt}`);
  }
  const summary = parts.filter(Boolean).join(" | ");
  return summary.length > 0 ? summary : null;
}

function buildLlmOutputs(value: unknown): BullpenAutoLiveLlmOutput[] {
  return asArray(value)
    .map((item) => asRecord(item))
    .flatMap((record) => {
      const provider = readString(record?.provider);
      const model = readString(record?.model);
      if (!record || !provider || !model) {
        return [];
      }

      return [
        {
          provider,
          model,
          llm_yes_odds: readNumber(record.llm_yes_odds),
          llm_no_odds: readNumber(record.llm_no_odds),
          confidence: readString(record.confidence),
          evidence_status: readString(record.evidence_status),
          event_state: readString(record.event_state),
          key_evidence: readStringArray(record.key_evidence),
          red_flags: readStringArray(record.red_flags),
          rationale: readString(record.rationale),
          error: readString(record.error),
          completed_at: readString(record.completed_at),
        },
      ];
    });
}

function buildCandidateRow(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidateByMarketId: Map<string, Record<string, unknown>>,
): BullpenAutoLiveConsoleCandidateInput | null {
  const marketId = readString(reviewedCandidate.market_id);
  const marketTitle = readString(reviewedCandidate.question);
  const fairYesProbability = readNumber(reviewedCandidate.fair_yes_probability_pct);
  const fairNoProbability = readNumber(reviewedCandidate.fair_no_probability_pct);

  if (!marketId || !marketTitle || (fairYesProbability === null && fairNoProbability === null)) {
    return null;
  }

  const acceptedCandidate = acceptedCandidateByMarketId.get(marketId);

  return {
    question_id: readString(acceptedCandidate?.question_id) ?? marketId,
    market_id: marketId,
    market_title: marketTitle,
    slug: readString(reviewedCandidate.slug) ?? readString(acceptedCandidate?.slug),
    market_url:
      readString(reviewedCandidate.market_url) ?? readString(acceptedCandidate?.market_url),
    close_time:
      readString(reviewedCandidate.close_time) ?? readString(acceptedCandidate?.close_time),
    theme: readString(acceptedCandidate?.theme) ?? "Uncategorized",
    current_yes_odds: readNumber(acceptedCandidate?.current_yes_odds),
    current_no_odds: readNumber(acceptedCandidate?.current_no_odds),
    llm_yes_odds: fairYesProbability,
    llm_no_odds: fairNoProbability,
    returns_per_day: readNumber(reviewedCandidate.returns_per_day),
    amount_to_be_invested: readNumber(acceptedCandidate?.amount_to_be_invested),
    llm_disagreement_level: readString(reviewedCandidate.disagreement_level),
    llm_disagreement_category: readString(reviewedCandidate.disagreement_category),
    adjudication_required: readBoolean(reviewedCandidate.adjudication_required),
    confidence: readString(reviewedCandidate.confidence),
    evidence_status: readString(reviewedCandidate.evidence_status),
    event_state: readString(reviewedCandidate.event_state),
    rules: buildRulesSummary(reviewedCandidate),
    selected: true,
    llm_outputs: buildLlmOutputs(reviewedCandidate.llm_outputs),
  };
}

export function buildBullpenStage3OnlyInvestPlan(
  run: BullpenAutoLiveRun | null,
): BullpenStage3OnlyInvestPlan {
  if (!run) {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: "Stage 2 needs to finish before Invest can reuse qualified events.",
    };
  }

  const llmOutputs = workflowStageOutputs(run, "llm");
  if (!llmOutputs || readString(llmOutputs.phase_status) !== "completed") {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: "Stage 2 must complete before Invest can reuse its qualified rows.",
    };
  }

  const scanOutputs = workflowStageOutputs(run, "scan");
  const acceptedCandidateByMarketId = buildAcceptedCandidateLookup(scanOutputs);

  const candidateRows = asArray(llmOutputs.llm_reviewed_candidates)
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => {
      if (!record) {
        return false;
      }
      return (
        readString(record.source_kind) !== "active_position" &&
        readBoolean(record.qualified)
      );
    })
    .map((record) => buildCandidateRow(record, acceptedCandidateByMarketId))
    .filter((row): row is BullpenAutoLiveConsoleCandidateInput => Boolean(row));

  if (candidateRows.length === 0) {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: "No Stage 2-qualified events are available to invest yet.",
    };
  }

  return {
    request: {
      console_profile: {
        source_label:
          readString(llmOutputs.scan_source_label) ??
          readString(scanOutputs?.scan_source_label) ??
          "Saved Stage 2 output",
        source_url:
          readString(llmOutputs.scan_source_url) ??
          readString(scanOutputs?.scan_source_url),
        scanned_at:
          readString(scanOutputs?.scanned_at) ?? run.completed_at ?? run.started_at,
        snapshot_id: readString(scanOutputs?.snapshot_id) ?? run.id,
        mode: readString(scanOutputs?.mode) ?? "stage-3-invest-only",
        total_candidates: candidateRows.length,
        reuse_saved_llm_outputs: true,
        candidate_rows: candidateRows,
      },
    },
    qualifiedCandidateCount: candidateRows.length,
    blockedReason: null,
  };
}
