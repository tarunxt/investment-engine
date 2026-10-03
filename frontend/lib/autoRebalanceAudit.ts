import type {
  AutoRebalanceHistoryItemResponse,
  AutoRebalanceRunMetadata,
  AutoRebalanceStageKey,
  AutoRebalanceStageResponse,
  AutoRebalanceStageUpdateRequest,
} from "@/types/api";

export type AutoRebalanceAuditState = {
  key: string;
  label: string;
  status: "pending" | "saved" | "failed";
  pending: number;
  message: string | null;
};

export type AutoRebalanceAuditWriteResult =
  | { saved: true }
  | { saved: false; error: string };

export function autoRebalanceAuditKey(metadata: AutoRebalanceRunMetadata) {
  return `${metadata.auto_rebalance_portfolio}:${metadata.auto_rebalance_sequence}`;
}

export function assertAutoRebalanceRunMetadata(
  metadata: unknown,
  expectedPortfolio: AutoRebalanceRunMetadata["auto_rebalance_portfolio"],
): asserts metadata is AutoRebalanceRunMetadata {
  if (
    !metadata || typeof metadata !== "object" ||
    !("auto_rebalance_portfolio" in metadata) ||
    metadata.auto_rebalance_portfolio !== expectedPortfolio ||
    !("auto_rebalance_sequence" in metadata) ||
    typeof metadata.auto_rebalance_sequence !== "number" ||
    !Number.isSafeInteger(metadata.auto_rebalance_sequence) ||
    metadata.auto_rebalance_sequence <= 0 ||
    !("auto_rebalance_label" in metadata) ||
    typeof metadata.auto_rebalance_label !== "string" ||
    !metadata.auto_rebalance_label.trim()
  ) {
    throw new Error("The server returned an invalid auto-rebalance reservation. No model work was started.");
  }
}

export function restoreAutoRebalanceAuditState(state: unknown): AutoRebalanceAuditState | null {
  if (
    !state || typeof state !== "object" ||
    !("key" in state) || typeof state.key !== "string" ||
    !("label" in state) || typeof state.label !== "string" ||
    !("status" in state) || !["pending", "saved", "failed"].includes(String(state.status)) ||
    !("pending" in state) || typeof state.pending !== "number" ||
    !Number.isFinite(state.pending) || state.pending < 0 ||
    !("message" in state) || (state.message !== null && typeof state.message !== "string")
  ) return null;
  const validState = state as AutoRebalanceAuditState;
  // A reload cannot restore an in-flight HTTP promise. Keep the uncertainty
  // visible without replaying historical writes or launching another workflow.
  return validState.status === "pending"
    ? {
        ...validState,
        status: "failed",
        pending: 0,
        message: "The previous browser session ended before run history was confirmed. Check saved run history.",
      }
    : validState;
}

const successfulStageStatuses = new Set(["completed", "partial", "skipped"]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** One current workflow's metadata only. This class cannot launch model work. */
export class AutoRebalanceAuditSession {
  readonly metadata: AutoRebalanceRunMetadata;
  readonly key: string;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private revision = 0;
  private latest = new Map<AutoRebalanceStageKey, AutoRebalanceStageUpdateRequest>();
  private failures = new Map<AutoRebalanceStageKey, string>();
  private verificationError: string | null = null;

  constructor(
    metadata: AutoRebalanceRunMetadata,
    private readonly dependencies: {
      persist: (
        stage: AutoRebalanceStageKey,
        payload: AutoRebalanceStageUpdateRequest,
      ) => Promise<AutoRebalanceStageResponse>;
      read: () => Promise<AutoRebalanceHistoryItemResponse>;
      delay: (ms: number) => Promise<void>;
      onChange: (state: AutoRebalanceAuditState) => void;
      onFailure?: (stage: AutoRebalanceStageKey, error: string) => void;
    },
  ) {
    this.metadata = { ...metadata };
    this.key = autoRebalanceAuditKey(metadata);
  }

  private publish() {
    const message = this.verificationError ?? [...this.failures.values()][0] ?? null;
    this.dependencies.onChange({
      key: this.key,
      label: this.metadata.auto_rebalance_label,
      status: this.pending ? "pending" : message ? "failed" : "saved",
      pending: this.pending,
      message,
    });
  }

  record(stage: AutoRebalanceStageKey, payload: AutoRebalanceStageUpdateRequest) {
    // Capture the exact identity and payload before any asynchronous work. A
    // different run may become active while this request is retrying.
    const previous = this.latest.get(stage);
    const capturedPayload = structuredClone({
      ...payload,
      run_id: payload.run_id ?? previous?.run_id ?? null,
      job_id: payload.job_id ?? previous?.job_id ?? null,
    });
    this.latest.set(stage, capturedPayload);
    this.revision += 1;
    this.pending += 1;
    this.verificationError = null;
    this.publish();
    const operation = this.tail.then(async (): Promise<AutoRebalanceAuditWriteResult> => {
      let failure = "Run history was not acknowledged by the server.";
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const saved = await this.dependencies.persist(stage, capturedPayload);
            if (saved.stage !== stage || saved.status !== capturedPayload.status) {
              throw new Error(`The saved ${stage} status does not match this update.`);
            }
            this.failures.delete(stage);
            return { saved: true };
          } catch (error) {
            failure = errorMessage(error);
            if (attempt < 2) await this.dependencies.delay(500 * (attempt + 1));
          }
        }
        this.failures.set(stage, `${stage}: ${failure}`);
        this.dependencies.onFailure?.(stage, failure);
        return { saved: false, error: failure };
      } finally {
        this.pending -= 1;
        this.publish();
      }
    });
    // Every writer shares this run's queue. A delayed "processing" write can
    // never overtake its terminal write, and callers can safely ignore a result
    // without creating an unhandled rejection or marking model output failed.
    this.tail = operation;
    return operation;
  }

  async drain() {
    let tail: Promise<unknown>;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }

  async verifyCompletion(requiredStages: readonly AutoRebalanceStageKey[]) {
    await this.drain();
    const revision = this.revision;
    this.pending += 1;
    this.publish();
    try {
      let history: AutoRebalanceHistoryItemResponse | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          history = await this.dependencies.read();
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await this.dependencies.delay(500 * (attempt + 1));
        }
      }
      if (
        revision !== this.revision ||
        !history ||
        history.portfolio !== this.metadata.auto_rebalance_portfolio ||
        history.sequence !== this.metadata.auto_rebalance_sequence ||
        !["completed", "partial"].includes(history.status)
      ) {
        throw new Error("The server has not confirmed this workflow as completed.");
      }
      for (const stage of requiredStages) {
        const expected = this.latest.get(stage);
        const actual = history.stages.find((item) => item.stage === stage);
        if (
          !expected ||
          !successfulStageStatuses.has(expected.status) ||
          !actual ||
          actual.status !== expected.status ||
          (expected.run_id != null && actual.run_id !== expected.run_id) ||
          (expected.job_id != null && actual.job_id !== expected.job_id) ||
          // History can infer a completed stage from worker jobs even when its
          // final audit write is missing. Require our submitted metadata too.
          Object.entries(expected.summary ?? {}).some(
            ([key, value]) => actual.summary?.[key] !== value,
          )
        ) {
          throw new Error(`The server has not confirmed the ${stage} history for this workflow.`);
        }
      }
      // A lost response may still have committed. Only matching server truth
      // clears such a failure; a successful unrelated stage cannot clear it.
      this.failures.clear();
      this.verificationError = null;
      return true;
    } catch (error) {
      this.verificationError = errorMessage(error);
      return false;
    } finally {
      this.pending -= 1;
      this.publish();
    }
  }
}
