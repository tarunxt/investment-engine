import type { ApiReadTransportCandidate } from "@/lib/urls";

type CircuitState = {
  failures: number;
  openUntil: number;
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
    if (!state || state.openUntil <= now) return candidates;
    return [
      ...candidates.filter((candidate) => candidate.stage !== "primary"),
      primary,
    ];
  }

  recordSuccess(candidate: ApiReadTransportCandidate) {
    if (candidate.stage === "primary") {
      this.states.delete(this.key(candidate));
    }
  }

  recordFailure(candidate: ApiReadTransportCandidate, now = Date.now()) {
    if (candidate.stage !== "primary") return;
    const key = this.key(candidate);
    const previous = this.states.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    this.states.set(key, {
      failures,
      openUntil:
        failures >= this.failureThreshold ? now + this.cooldownMs : 0,
    });
  }

  snapshot(candidate: ApiReadTransportCandidate) {
    return this.states.get(this.key(candidate)) ?? null;
  }
}

export function getApiReadAttemptBudget({
  startedAt,
  now,
  index,
  candidateCount,
  totalBudgetMs,
  primaryAttemptBudgetMs,
}: {
  startedAt: number;
  now: number;
  index: number;
  candidateCount: number;
  totalBudgetMs: number;
  primaryAttemptBudgetMs: number;
}) {
  const remainingMs = Math.max(0, totalBudgetMs - (now - startedAt));
  if (index === 0 && candidateCount > 1) {
    return Math.min(remainingMs, primaryAttemptBudgetMs);
  }
  return remainingMs;
}
