import type { ApiReadTransportCandidate } from "@/lib/urls";

type CircuitState = {
  phase: "closed" | "open" | "half-open";
  failures: number;
  openedAt: number | null;
  probeInFlight: boolean;
};

export class ApiReadCircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  constructor(
    private readonly failureThreshold = 2,
    private readonly cooldownMs = 30_000,
  ) {}

  private key(candidate: ApiReadTransportCandidate) {
    return new URL(
      candidate.url,
      typeof window === "undefined" ? "http://localhost" : window.location.origin,
    ).origin;
  }

  order(
    candidates: ApiReadTransportCandidate[],
    now = Date.now(),
  ): ApiReadTransportCandidate[] {
    const primary = candidates.find((candidate) => candidate.stage === "primary");
    if (!primary) return candidates;
    const state = this.states.get(this.key(primary));
    if (!state || state.phase === "closed") return candidates;
    const fallbacks = candidates.filter(
      (candidate) => candidate.stage !== "primary",
    );
    if (state.phase === "half-open") return fallbacks;
    if (
      state.openedAt !== null &&
      now - state.openedAt < this.cooldownMs
    ) {
      return fallbacks;
    }
    this.states.set(this.key(primary), {
      ...state,
      phase: "half-open",
      probeInFlight: true,
    });
    return [primary, ...fallbacks];
  }

  recordSuccess(candidate: ApiReadTransportCandidate) {
    if (candidate.stage === "primary") {
      this.states.set(this.key(candidate), {
        phase: "closed",
        failures: 0,
        openedAt: null,
        probeInFlight: false,
      });
    }
  }

  recordFailure(candidate: ApiReadTransportCandidate, now = Date.now()) {
    if (candidate.stage !== "primary") return;
    const key = this.key(candidate);
    const previous = this.states.get(key);
    const failures =
      previous?.phase === "half-open"
        ? this.failureThreshold
        : (previous?.failures ?? 0) + 1;
    this.states.set(key, {
      phase: failures >= this.failureThreshold ? "open" : "closed",
      failures,
      openedAt: failures >= this.failureThreshold ? now : null,
      probeInFlight: false,
    });
  }

  snapshot(candidate: ApiReadTransportCandidate) {
    return (
      this.states.get(this.key(candidate)) ?? {
        phase: "closed" as const,
        failures: 0,
        openedAt: null,
        probeInFlight: false,
      }
    );
  }
}

export function getApiReadAttemptBudget({
  startedAt,
  now,
  candidateStage,
  candidateCount,
  totalBudgetMs,
  primaryAttemptBudgetMs,
}: {
  startedAt: number;
  now: number;
  candidateStage: ApiReadTransportCandidate["stage"];
  candidateCount: number;
  totalBudgetMs: number;
  primaryAttemptBudgetMs: number;
}) {
  const remainingMs = Math.max(0, totalBudgetMs - (now - startedAt));
  if (candidateStage === "primary" && candidateCount > 1) {
    return Math.min(remainingMs, primaryAttemptBudgetMs);
  }
  return remainingMs;
}
