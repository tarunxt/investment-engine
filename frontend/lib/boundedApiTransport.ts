export type ApiCandidateStage = "primary" | "secondary" | "tertiary";

export type BoundedApiCandidate = {
  baseUrl: string;
  stage: ApiCandidateStage;
  transport: string;
};

export type CircuitPhase = "closed" | "open" | "half-open";

type CircuitRecord = {
  phase: CircuitPhase;
  failures: number;
  openedAt: number | null;
  probeInFlight: boolean;
};

export type CircuitLease = "normal" | "probe" | "skip";

function candidateOrigin(candidate: BoundedApiCandidate) {
  return new URL(candidate.baseUrl).origin;
}

export class ApiOriginCircuitBreaker {
  private readonly records = new Map<string, CircuitRecord>();

  constructor(
    private readonly failureThreshold = 2,
    private readonly cooldownMs = 30_000,
  ) {}

  acquire(candidate: BoundedApiCandidate, now: number): CircuitLease {
    const origin = candidateOrigin(candidate);
    const record = this.records.get(origin);
    if (!record || record.phase === "closed") return "normal";

    if (record.phase === "half-open") {
      return record.probeInFlight ? "skip" : "probe";
    }

    if (
      record.openedAt !== null &&
      now - record.openedAt < this.cooldownMs
    ) {
      return "skip";
    }

    this.records.set(origin, {
      ...record,
      phase: "half-open",
      probeInFlight: true,
    });
    return "probe";
  }

  recordSuccess(candidate: BoundedApiCandidate) {
    this.records.set(candidateOrigin(candidate), {
      phase: "closed",
      failures: 0,
      openedAt: null,
      probeInFlight: false,
    });
  }

  recordFailure(
    candidate: BoundedApiCandidate,
    lease: Exclude<CircuitLease, "skip">,
    now: number,
  ) {
    const origin = candidateOrigin(candidate);
    const current = this.records.get(origin);
    const failures =
      lease === "probe" ? this.failureThreshold : (current?.failures ?? 0) + 1;
    if (failures >= this.failureThreshold) {
      this.records.set(origin, {
        phase: "open",
        failures,
        openedAt: now,
        probeInFlight: false,
      });
      return;
    }
    this.records.set(origin, {
      phase: "closed",
      failures,
      openedAt: null,
      probeInFlight: false,
    });
  }

  snapshot(candidate: BoundedApiCandidate): Readonly<CircuitRecord> {
    return (
      this.records.get(candidateOrigin(candidate)) ?? {
        phase: "closed",
        failures: 0,
        openedAt: null,
        probeInFlight: false,
      }
    );
  }
}

export class ApiTransportDeadlineError extends Error {
  constructor() {
    super("The logical API request deadline was exhausted.");
    this.name = "ApiTransportDeadlineError";
  }
}

type Clock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export type BufferedTransportResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  body: ArrayBuffer | null;
};

type ExecuteBoundedApiRequestOptions = {
  method: string;
  candidates: BoundedApiCandidate[];
  circuit: ApiOriginCircuitBreaker;
  fetchCandidate: (
    candidate: BoundedApiCandidate,
    signal: AbortSignal,
  ) => Promise<BufferedTransportResponse>;
  refreshAuthentication?: (signal: AbortSignal) => Promise<void>;
  callerSignal?: AbortSignal;
  totalBudgetMs: number;
  primaryAttemptBudgetMs: number;
  clock?: Clock;
};

function isRetryableStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function abortError() {
  return new DOMException("Request aborted", "AbortError");
}

async function withinBudget<T>({
  operation,
  callerSignal,
  budgetMs,
  clock,
}: {
  operation: (signal: AbortSignal) => Promise<T>;
  callerSignal?: AbortSignal;
  budgetMs: number;
  clock: Clock;
}) {
  if (callerSignal?.aborted) throw abortError();
  if (budgetMs <= 0) throw new ApiTransportDeadlineError();

  const controller = new AbortController();
  let timedOut = false;
  const abortForCaller = () => controller.abort();
  callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (callerSignal?.aborted) throw abortError();
    if (timedOut) throw new ApiTransportDeadlineError();
    throw error;
  } finally {
    clock.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortForCaller);
  }
}

export async function executeBoundedApiRequest({
  method,
  candidates,
  circuit,
  fetchCandidate,
  refreshAuthentication,
  callerSignal,
  totalBudgetMs,
  primaryAttemptBudgetMs,
  clock = systemClock,
}: ExecuteBoundedApiRequestOptions) {
  const startedAt = clock.now();
  const canFallback = method === "GET" || method === "HEAD";
  const eligibleCandidates = canFallback ? candidates : candidates.slice(0, 1);
  let lastError: unknown = null;
  let lastRetryableResponse: BufferedTransportResponse | null = null;

  for (const candidate of eligibleCandidates) {
    const lease = circuit.acquire(candidate, clock.now());
    if (lease === "skip") continue;

    let authenticationRefreshed = false;
    while (true) {
      const remainingMs = totalBudgetMs - (clock.now() - startedAt);
      if (remainingMs <= 0) throw new ApiTransportDeadlineError();
      const attemptBudgetMs =
        candidate.stage === "primary" && eligibleCandidates.length > 1
          ? Math.min(primaryAttemptBudgetMs, remainingMs)
          : remainingMs;

      let response: BufferedTransportResponse;
      try {
        response = await withinBudget({
          operation: (signal) => fetchCandidate(candidate, signal),
          callerSignal,
          budgetMs: attemptBudgetMs,
          clock,
        });
      } catch (error) {
        if (
          callerSignal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw error;
        }
        circuit.recordFailure(candidate, lease, clock.now());
        lastError = error;
        break;
      }

      // A 401 proves that the transport is reachable. Refresh once, on the
      // same candidate and inside the same absolute logical deadline.
      if (
        response.status === 401 &&
        refreshAuthentication &&
        !authenticationRefreshed
      ) {
        authenticationRefreshed = true;
        const remainingAfter401 = totalBudgetMs - (clock.now() - startedAt);
        try {
          await withinBudget({
            operation: refreshAuthentication,
            callerSignal,
            budgetMs: remainingAfter401,
            clock,
          });
        } catch (error) {
          if (lease === "probe") {
            circuit.recordFailure(candidate, lease, clock.now());
          }
          throw error;
        }
        continue;
      }

      if (!isRetryableStatus(response.status)) {
        circuit.recordSuccess(candidate);
        return { candidate, response };
      }

      circuit.recordFailure(candidate, lease, clock.now());
      lastRetryableResponse = response;
      break;
    }
  }

  if (lastRetryableResponse) {
    return { candidate: null, response: lastRetryableResponse };
  }
  if (lastError) throw lastError;
  throw new ApiTransportDeadlineError();
}
