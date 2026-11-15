type RequestIdentity = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export class PrivateRequestDeduplicator {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private sessionGeneration = "anonymous";

  setSessionGeneration(generation: string) {
    const normalized = generation.trim() || "anonymous";
    if (normalized === this.sessionGeneration) return;
    this.sessionGeneration = normalized;
    this.inFlight.clear();
  }

  key(identity: RequestIdentity) {
    const normalizedUrl = new URL(identity.url, "http://localhost");
    normalizedUrl.hash = "";
    normalizedUrl.searchParams.sort();
    const relevantHeaders = Object.entries(identity.headers ?? {})
      .filter(([name]) => name.toLowerCase() !== "x-correlation-id")
      .map(([name, value]) => [name.toLowerCase(), String(value)] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([
      identity.method.toUpperCase(),
      normalizedUrl.toString(),
      relevantHeaders,
      this.sessionGeneration,
    ]);
  }

  run<T>(identity: RequestIdentity, operation: () => Promise<T>): Promise<T> {
    // Sharing a promise would couple caller-owned cancellation. Independently
    // cancellable callers therefore receive independent requests.
    if (identity.signal) return operation();

    const key = this.key(identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const request = operation().finally(() => {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, request);
    return request;
  }
}
