import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadTypescriptModule(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "module", output)(loaded.exports, loaded);
  return loaded.exports;
}

const {
  ApiOriginCircuitBreaker,
  ApiTransportDeadlineError,
  executeBoundedApiRequest,
} = loadTypescriptModule("../lib/boundedApiTransport.ts");
const { PrivateRequestDeduplicator } = loadTypescriptModule(
  "../lib/privateRequestDeduplicator.ts",
);
const { SingleFlightByKey } = loadTypescriptModule("../lib/singleFlight.ts");

const direct = {
  baseUrl: "https://api.example.test",
  stage: "primary",
  transport: "direct",
};
const proxy = {
  baseUrl: "https://app.example.test/backend-api",
  stage: "secondary",
  transport: "proxy",
};

function response(status = 200, body = "{}") {
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(body).buffer,
  };
}

class FakeClock {
  nowMs = 0;
  nextId = 1;
  timers = new Map();

  now = () => this.nowMs;

  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.nowMs + delayMs });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  advance(ms) {
    const target = this.nowMs + ms;
    while (true) {
      const pending = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!pending) break;
      const [id, timer] = pending;
      this.timers.delete(id);
      this.nowMs = timer.due;
      timer.callback();
    }
    this.nowMs = target;
  }
}

function baseOptions(overrides = {}) {
  const clock = overrides.clock ?? new FakeClock();
  return {
    method: "GET",
    candidates: [direct, proxy],
    circuit: new ApiOriginCircuitBreaker(2, 1_000),
    totalBudgetMs: 500,
    primaryAttemptBudgetMs: 100,
    clock,
    ...overrides,
  };
}

test("direct success is returned once without replaying the fallback", async () => {
  const calls = [];
  const result = await executeBoundedApiRequest(
    baseOptions({
      fetchCandidate: async (candidate) => {
        calls.push(candidate.transport);
        return response(200, '{"source":"direct"}');
      },
    }),
  );
  assert.equal(result.candidate.transport, "direct");
  assert.deepEqual(calls, ["direct"]);
});

test("retryable primary failure reaches a successful proxy once", async () => {
  const calls = [];
  const result = await executeBoundedApiRequest(
    baseOptions({
      fetchCandidate: async (candidate) => {
        calls.push(candidate.transport);
        return candidate.stage === "primary" ? response(503) : response(200);
      },
    }),
  );
  assert.equal(result.candidate.transport, "proxy");
  assert.deepEqual(calls, ["direct", "proxy"]);
});

test("mutations never switch transports automatically", async () => {
  const calls = [];
  const result = await executeBoundedApiRequest(
    baseOptions({
      method: "POST",
      fetchCandidate: async (candidate) => {
        calls.push(candidate.transport);
        return response(503);
      },
    }),
  );
  assert.deepEqual(calls, ["direct"]);
  assert.equal(result.response.status, 503);
});

test("primary timeout uses the remaining budget on the proxy", async () => {
  const clock = new FakeClock();
  const calls = [];
  const result = await executeBoundedApiRequest(
    baseOptions({
      clock,
      fetchCandidate: async (candidate, signal) => {
        calls.push(candidate.transport);
        if (candidate.stage !== "primary") return response(200);
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
          clock.advance(101);
        });
      },
    }),
  );
  assert.equal(result.candidate.transport, "proxy");
  assert.deepEqual(calls, ["direct", "proxy"]);
});

test("circuit opens after its measured failure threshold", () => {
  const circuit = new ApiOriginCircuitBreaker(2, 1_000);
  circuit.recordFailure(direct, "normal", 10);
  assert.equal(circuit.snapshot(direct).phase, "closed");
  circuit.recordFailure(direct, "normal", 20);
  assert.equal(circuit.snapshot(direct).phase, "open");
  assert.equal(circuit.acquire(direct, 500), "skip");
});

test("exactly one half-open recovery probe runs under concurrency", async () => {
  const circuit = new ApiOriginCircuitBreaker(1, 100);
  circuit.recordFailure(direct, "normal", 0);
  const clock = new FakeClock();
  clock.advance(101);
  let resolveProbe;
  let primaryCalls = 0;
  let proxyCalls = 0;
  const fetchCandidate = async (candidate) => {
    if (candidate.stage === "primary") {
      primaryCalls += 1;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    }
    proxyCalls += 1;
    return response(200, '{"source":"proxy"}');
  };
  const options = baseOptions({ circuit, clock, fetchCandidate });
  const probe = executeBoundedApiRequest(options);
  await Promise.resolve();
  const concurrent = await executeBoundedApiRequest(options);
  assert.equal(concurrent.candidate.transport, "proxy");
  assert.equal(primaryCalls, 1);
  assert.equal(proxyCalls, 1);
  resolveProbe(response(200, '{"source":"recovered"}'));
  const recovered = await probe;
  assert.equal(recovered.candidate.transport, "direct");
  assert.equal(circuit.snapshot(direct).phase, "closed");
});

test("a failed half-open probe reopens the circuit", async () => {
  const circuit = new ApiOriginCircuitBreaker(1, 100);
  circuit.recordFailure(direct, "normal", 0);
  const clock = new FakeClock();
  clock.advance(101);
  const result = await executeBoundedApiRequest(
    baseOptions({
      circuit,
      clock,
      fetchCandidate: async (candidate) => {
        if (candidate.stage === "primary") throw new TypeError("offline");
        return response(200);
      },
    }),
  );
  assert.equal(result.candidate.transport, "proxy");
  assert.equal(circuit.snapshot(direct).phase, "open");
});

test("a failed half-open authentication refresh releases and reopens the probe", async () => {
  const circuit = new ApiOriginCircuitBreaker(1, 100);
  circuit.recordFailure(direct, "normal", 0);
  const clock = new FakeClock();
  clock.advance(101);
  await assert.rejects(
    executeBoundedApiRequest(
      baseOptions({
        circuit,
        clock,
        fetchCandidate: async () => response(401),
        refreshAuthentication: async () => {
          throw new Error("refresh unavailable");
        },
      }),
    ),
    /refresh unavailable/,
  );
  assert.equal(circuit.snapshot(direct).phase, "open");
  assert.equal(circuit.snapshot(direct).probeInFlight, false);
});

test("primary and fallback share one absolute logical deadline", async () => {
  const clock = new FakeClock();
  await assert.rejects(
    executeBoundedApiRequest(
      baseOptions({
        clock,
        totalBudgetMs: 200,
        primaryAttemptBudgetMs: 100,
        fetchCandidate: async (_candidate, signal) =>
          new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
            clock.advance(101);
          }),
      }),
    ),
    ApiTransportDeadlineError,
  );
  assert.ok(clock.nowMs <= 202);
});

test("401 refresh and retry stay on one candidate and one deadline", async () => {
  const clock = new FakeClock();
  let fetchCalls = 0;
  let refreshCalls = 0;
  const result = await executeBoundedApiRequest(
    baseOptions({
      clock,
      totalBudgetMs: 200,
      fetchCandidate: async () => {
        fetchCalls += 1;
        clock.advance(50);
        return fetchCalls === 1 ? response(401) : response(200);
      },
      refreshAuthentication: async () => {
        refreshCalls += 1;
        clock.advance(50);
      },
    }),
  );
  assert.equal(result.candidate.transport, "direct");
  assert.equal(fetchCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(clock.nowMs, 150);
});

test("identical requests deduplicate within one session generation", async () => {
  const deduplicator = new PrivateRequestDeduplicator();
  deduplicator.setSessionGeneration("user-1:session-a");
  let calls = 0;
  let resolveRequest;
  const operation = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };
  const identity = {
    method: "GET",
    url: "https://app.test/backend-api/runs?b=2&a=1",
    headers: { Accept: "application/json" },
  };
  const first = deduplicator.run(identity, operation);
  const second = deduplicator.run(
    { ...identity, url: "https://app.test/backend-api/runs?a=1&b=2" },
    operation,
  );
  assert.equal(calls, 1);
  resolveRequest({ ok: true });
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true },
    { ok: true },
  ]);
});

test("private responses never deduplicate across session generations", async () => {
  const deduplicator = new PrivateRequestDeduplicator();
  let calls = 0;
  const identity = { method: "GET", url: "https://app.test/backend-api/runs" };
  deduplicator.setSessionGeneration("user-1:session-a");
  const first = deduplicator.run(identity, async () => ++calls);
  deduplicator.setSessionGeneration("user-2:session-b");
  const second = deduplicator.run(identity, async () => ++calls);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test("caller-owned cancellation remains independent", async () => {
  const deduplicator = new PrivateRequestDeduplicator();
  const left = new AbortController();
  const right = new AbortController();
  let calls = 0;
  const identity = { method: "GET", url: "https://app.test/backend-api/runs" };
  const operation = async () => ++calls;
  await Promise.all([
    deduplicator.run({ ...identity, signal: left.signal }, operation),
    deduplicator.run({ ...identity, signal: right.signal }, operation),
  ]);
  assert.equal(calls, 2);
});

test("concurrent token refreshes share exactly one single-flight operation", async () => {
  const flights = new SingleFlightByKey();
  let calls = 0;
  let resolveRefresh;
  const refresh = () =>
    flights.run("hashed-refresh-identity", () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    });
  const first = refresh();
  const second = refresh();
  assert.equal(calls, 1);
  resolveRefresh({ accessToken: "server-only" });
  assert.deepEqual(await Promise.all([first, second]), [
    { accessToken: "server-only" },
    { accessToken: "server-only" },
  ]);
});
