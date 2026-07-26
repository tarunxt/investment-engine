import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function loadCircuitModule() {
  const source = read("../lib/apiReadCircuitBreaker.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("exports", "module", output)(
    loadedModule.exports,
    loadedModule,
  );
  return loadedModule.exports;
}

const direct = {
  url: "https://api.cred-x.in/dashboard/summary",
  stage: "primary",
  transport: "configured-or-inferred-api",
};
const proxy = {
  url: "https://cred-x.in/backend-api/dashboard/summary",
  stage: "secondary",
  transport: "same-origin-proxy",
};

test("browser read circuit exposes closed, open, and single half-open probe states", () => {
  const { ApiReadCircuitBreaker } = loadCircuitModule();
  const circuit = new ApiReadCircuitBreaker(2, 30_000);

  assert.deepEqual(circuit.order([direct, proxy], 1_000), [direct, proxy]);
  circuit.recordFailure(direct, 1_000);
  assert.deepEqual(circuit.order([direct, proxy], 1_001), [direct, proxy]);
  circuit.recordFailure(direct, 1_002);
  assert.equal(circuit.snapshot(direct).phase, "open");
  assert.deepEqual(circuit.order([direct, proxy], 1_003), [proxy]);

  circuit.recordSuccess(proxy);
  assert.deepEqual(circuit.order([direct, proxy], 20_000), [proxy]);
  assert.deepEqual(circuit.order([direct, proxy], 31_003), [direct, proxy]);
  assert.equal(circuit.snapshot(direct).phase, "half-open");
  assert.deepEqual(circuit.order([direct, proxy], 31_004), [proxy]);

  circuit.recordSuccess(direct);
  assert.equal(circuit.snapshot(direct).phase, "closed");
});

test("read attempts share one deadline instead of receiving full timeouts", () => {
  const { getApiReadAttemptBudget } = loadCircuitModule();

  assert.equal(
    getApiReadAttemptBudget({
      startedAt: 0,
      now: 10,
      candidateStage: "primary",
      candidateCount: 2,
      totalBudgetMs: 5_000,
      primaryAttemptBudgetMs: 1_500,
    }),
    1_500,
  );
  assert.equal(
    getApiReadAttemptBudget({
      startedAt: 0,
      now: 1_510,
      candidateStage: "secondary",
      candidateCount: 2,
      totalBudgetMs: 5_000,
      primaryAttemptBudgetMs: 1_500,
    }),
    3_490,
  );
});

test("dashboard cache is user-scoped and below-fold panels mount on visibility", () => {
  const dashboard = read("../app/console/dashboard/DashboardPageClient.tsx");
  const automatedRebalance = read(
    "../app/console/automated-rebalance/_components/AutomatedRebalanceClient.tsx",
  );
  const lazyMount = read("../components/shared/LazyMount.tsx");

  assert.match(dashboard, /dashboard-overview-cache:v3:user:/);
  assert.match(dashboard, /dashboardOverviewCacheKey\(userId\)/);
  assert.match(dashboard, /getDashboardSummary\(\)/);
  assert.doesNotMatch(dashboard, /useUsdInrRate/);
  assert.doesNotMatch(dashboard, /RebalanceWorkflowSections/);
  assert.match(dashboard, /automatedRebalance\(\)/);
  assert.match(automatedRebalance, /RebalanceWorkflowSections/);
  assert.match(dashboard, /Its histories, editors, polling, and model/);
  assert.doesNotMatch(dashboard, /DashboardFinalActionablesTables/);
  assert.match(dashboard, /Full histories, model evidence, and action tables load only/);
  assert.match(dashboard, /onVisible=\{\(\) => \{[\s\S]*loadThreats/);
  assert.match(dashboard, /data-performance-usable=/);
  assert.match(lazyMount, /IntersectionObserver/);
});

test("hidden Bullpen legacy controls remain disabled", () => {
  const bullpen = read(
    "../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx",
  );
  const sidebar = read("../app/console/_components/SidebarNavigation.tsx");

  assert.match(
    bullpen,
    /NEXT_PUBLIC_RENDER_LEGACY_BULLPEN_SCAN === "true"/,
  );
  assert.match(bullpen, /RENDER_LEGACY_SCAN_CONTROLS \? \(/);
  assert.match(bullpen, /data-performance-usable="bullpen-runtime"/);
  assert.match(sidebar, /prefetch=\{false\}/);
});

test("Nginx caches only immutable assets and bypasses buffering for sockets", () => {
  const nginx = read("../../deploy/no-docker/nginx/investor.conf");

  assert.match(nginx, /listen 443 ssl;\s+http2 on;/);
  assert.match(
    nginx,
    /location \/_next\/static\/[\s\S]*max-age=31536000, immutable/,
  );
  assert.match(nginx, /location \^~ \/console\/[\s\S]*private, no-store/);
  assert.match(nginx, /location \^~ \/backend-api\/[\s\S]*private, no-store/);
  assert.match(nginx, /location \/ws\/[\s\S]*proxy_buffering off/);
  assert.match(nginx, /upstream investor_backend[\s\S]*keepalive 32/);
});
