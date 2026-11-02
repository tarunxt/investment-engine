import type { BullpenAutoLiveDecision } from "@/types/api";

export type StageTwoDecisionDialogState = {
  decision: BullpenAutoLiveDecision;
  llmContext: Record<string, unknown> | null;
};

export type StageTwoDecisionDialogMode = "tag" | "llm-inputs";

export type StageTwoLlmEventInputDialogState = {
  title: string;
  llmContext: Record<string, unknown> | null;
};

export function formatOddsPercent(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

export function formatUsdCost(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function formatPriceCents(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}c`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type RunSummaryWarning = { label: string; detail: string };

export type PlannedOrderDetailState = {
  title: string;
  summary: string;
  detail: string;
};

export type DecisionLlmOddsState = { decision: BullpenAutoLiveDecision };

export type StageTwoRunSummaryStatus =
  | "completed"
  | "failed"
  | "partial"
  | "pending"
  | "running";

export type StageTwoLlmRunSummaryRow = {
  key: string;
  provider: string;
  model: string;
  displayModel: string;
  requestedModel: string | null;
  status: StageTwoRunSummaryStatus;
  runtime: string;
  cost: number | null;
  error: string | null;
  failureCategory: string | null;
  firstError: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  batchErrors: Record<string, unknown>[];
  failedEventCount: number | null;
  invalidEventCount: number | null;
  blockedEventCount: number | null;
  retryRequestCount: number | null;
  recoveryBatchCount: number | null;
};

export type StageTwoLlmFailureDialogRow = StageTwoLlmRunSummaryRow;

export function getStageTwoLlmFailureFixAdvice(row: StageTwoLlmFailureDialogRow) {
  const error = (row.error ?? "").toLowerCase();
  const provider = row.provider.toLowerCase();

  if (
    /api key|authentication|unauthorized|permission|credential|token/.test(
      error,
    )
  ) {
    return `Check the ${row.provider} API key/credentials in the backend environment, restart investor-backend and investor-celery-worker, then rerun Stage 2.`;
  }
  if (/rate limit|quota|429|resource exhausted|too many requests/.test(error)) {
    return `Reduce ${row.provider} concurrency or selected models, wait for quota to recover, verify billing/quota, then rerun this LLM.`;
  }
  if (
    /timeout|timed out|deadline|network|fetch failed|connection|econnreset/.test(
      error,
    )
  ) {
    return `Check provider connectivity from the worker, increase/retry-safe task timeout if needed, and rerun after the network/provider stabilizes.`;
  }
  if (/json|parse|schema|invalid|malformed|unusable/.test(error)) {
    return `Review the Stage 2 prompt/schema instructions for ${row.model}, keep the model response JSON-only, and rerun this model.`;
  }
  if (provider.includes("gemini")) {
    return "Verify Gemini model availability, API key, quota, and safety/block settings before rerunning this Gemini target.";
  }
  if (provider.includes("openai")) {
    return "Verify OpenAI model access, API key, project billing/quota, and request limits before rerunning this OpenAI target.";
  }
  if (provider.includes("deepseek")) {
    return "Verify Deepseek API key, model availability, account credits/quota, and request limits before rerunning this Deepseek target.";
  }
  return "Open backend/Celery logs for the exact traceback, fix the provider/configuration issue, then rerun Stage 2 for this model.";
}

export function hasReturnedValue(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

export function formatJsonForDisplay(value: unknown) {
  if (!hasReturnedValue(value)) return "Not returned for this run.";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function readNestedRecord(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  let cursor = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : null;
}

export function readFirstReturnedValue(...values: unknown[]) {
  return values.find(hasReturnedValue);
}

export function getStageTwoDisplayedPrompt(
  llmContext: Record<string, unknown> | null,
  promptTemplate: unknown,
) {
  return readFirstReturnedValue(llmContext?.llm_prompt, promptTemplate);
}

export function getStageTwoLlmPromptInputs(
  llmContext: Record<string, unknown> | null,
) {
  return readFirstReturnedValue(
    llmContext?.llm_prompt_inputs,
    llmContext?.prompt_inputs,
  );
}

export function getStageTwoLlmPromptInputMarket(
  llmContext: Record<string, unknown> | null,
) {
  return readNestedRecord(getStageTwoLlmPromptInputs(llmContext), ["market"]);
}

export function getStageTwoLlmPromptInputEvidencePacket(
  llmContext: Record<string, unknown> | null,
) {
  return readFirstReturnedValue(
    llmContext?.evidence_packet,
    readNestedRecord(getStageTwoLlmPromptInputs(llmContext), [
      "evidence_packet",
    ]),
  );
}

export function getStageTwoLlmMissingValueReason(
  label: string,
  primaryValue: unknown,
  fallbackValue?: unknown,
) {
  if (hasReturnedValue(primaryValue)) return null;
  if (hasReturnedValue(fallbackValue)) {
    return `${label} was not returned as a top-level Stage 2 field for this run, so the console is showing it from the organised prompt inputs captured with the LLM review.`;
  }
  return `${label} was not returned in this run payload. This usually means the run was created before that field was persisted, or the upstream Polymarket scan did not supply that optional value for this market.`;
}

export function getStageTwoPromptMissingValueReason(
  label: string,
  llmContext: Record<string, unknown> | null,
  promptTemplate: unknown,
) {
  const prompt = llmContext?.llm_prompt;
  if (hasReturnedValue(prompt)) return null;
  if (hasReturnedValue(promptTemplate)) {
    return `${label} was not returned as a per-row Stage 2 field for this run, so the console is showing the saved Stage 2 prompt template used for shared LLM execution.`;
  }
  return getStageTwoLlmMissingValueReason(label, prompt);
}
