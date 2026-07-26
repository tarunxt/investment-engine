import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertTypeScriptParses(relativePath) {
  const source = read(relativePath);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: relativePath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
  );
}

test("Bullpen positions use one auth context and passive page-load reads", () => {
  const positionsSource = read("../app/api/bullpen-ai/positions/route.ts");
  const marketResolutionSource = read(
    "../app/api/bullpen-ai/_lib/polymarketMarketUrls.ts",
  );

  assert.match(positionsSource, /createBackendSessionContext\(request\)/);
  assert.match(
    positionsSource,
    /loadTrackedPositionsFallback\(context: BackendSessionContext\)/,
  );
  assert.match(
    positionsSource,
    /fetchBackendJsonWithSession<PolymarketBotState>/,
  );
  assert.doesNotMatch(positionsSource, /new URL\("\/backend-api\/polymarket\/state"/);
  assert.match(positionsSource, /passiveValue === null\s*\? true/);
  assert.match(positionsSource, /forceFresh\s*\? false/);
  assert.match(positionsSource, /backendQuery\.set\("passive", "true"\)/);
  assert.match(
    positionsSource,
    /backendAccessToken:\s*context\.accessToken/,
  );
  assert.match(
    positionsSource,
    /runtimeSearch:\s*\(path, options\) =>\s*fetchBackendJsonWithSession\(context, path, options\)/,
  );
  assert.match(
    marketResolutionSource,
    /accessToken:\s*options\.backendAccessToken/,
  );
  assert.match(
    marketResolutionSource,
    /allowRuntimeQuestionFallback === false/,
  );
  assert.match(
    marketResolutionSource,
    /maxRuntimeQuestionFallbacks \?\? 1/,
  );
  assert.match(
    positionsSource,
    /allowRuntimeQuestionFallback:\s*false/,
  );
  assert.match(
    positionsSource,
    /\{ allowRuntimeQuestionFallback: !passive \}/,
  );
  assert.match(
    positionsSource,
    /\{ allowRuntimeQuestionFallback: false \}/,
  );
  assert.match(positionsSource, /conditionId:\s*position\.conditionId/);
  assert.match(
    marketResolutionSource,
    /params\.append\("conditionId", conditionId\)/,
  );
  assert.match(
    marketResolutionSource,
    /recordsByConditionId\.get\(question\.conditionId\.trim\(\)\)/,
  );
  assert.match(
    marketResolutionSource,
    /question-text match[\s\S]+authoritativeMarketOpen:\s*null/,
  );
});

test("Bullpen healthcheck systemd unit is a passive backend cache reader", () => {
  const installer = read("../../deploy/no-docker/install-bullpen-healthcheck.sh");
  const service = read(
    "../../deploy/no-docker/systemd/credx-bullpen-healthcheck.service",
  );
  const timer = read(
    "../../deploy/no-docker/systemd/credx-bullpen-healthcheck.timer",
  );
  const workflow = read("../../.github/workflows/deploy.yml");

  assert.match(installer, /systemctl enable --now "\$TIMER_NAME"/);
  assert.match(installer, /systemctl start "\$SERVICE_NAME"/);
  assert.match(installer, /--property=ExecMainStatus/);
  assert.match(installer, /journalctl --unit "\$SERVICE_NAME"/);
  assert.match(installer, /BACKEND_ENV_FILE=.*\/etc\/investor\/backend\.env/);
  assert.match(installer, /backend\/\.venv\/bin\/python/);
  assert.doesNotMatch(installer, /FRONTEND_ENV_FILE|\/usr\/bin\/node/);
  assert.match(
    service,
    /-m app\.domains\.polymarket\.passive_healthcheck/,
  );
  assert.match(service, /EnvironmentFile=__BACKEND_ENV_FILE__/);
  assert.doesNotMatch(service, /scripts\/bullpen-healthcheck|\/usr\/bin\/node/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(workflow, /install-bullpen-healthcheck\.sh/);
  assert.match(
    workflow,
    /BACKEND_ENV_FILE="\$BACKEND_ENV_FILE"[\s\S]+install-bullpen-healthcheck\.sh/,
  );
});

test("Bullpen Celery launchers bound retained memory and retire the legacy override", () => {
  const primaryLauncher = read(
    "../../deploy/no-docker/scripts/run-celery-worker.sh",
  );
  const planningLauncher = read(
    "../../deploy/no-docker/scripts/run-celery-auto-live-worker.sh",
  );
  const emailLauncher = read(
    "../../deploy/no-docker/scripts/run-celery-email-worker.sh",
  );
  const redeploy = read("../../deploy/no-docker/redeploy.sh");
  const productionDocs = read("../../docs/production-deploy.md");
  const auditDocs = read("../../docs/bullpen-run-audit.md");

  assert.match(primaryLauncher, /CELERY_AI_WORKER_CONCURRENCY:-1/);
  assert.match(primaryLauncher, /-Q "\$EFFECTIVE_CELERY_WORKER_QUEUES"/);
  assert.match(emailLauncher, /-Q email/);
  assert.match(emailLauncher, /CELERY_EMAIL_WORKER_CONCURRENCY:-1/);
  assert.match(primaryLauncher, /CELERY_WORKER_MAX_TASKS_PER_CHILD:-\$\{CELERY_MAX_TASKS_PER_CHILD:-25\}/);
  assert.match(primaryLauncher, /CELERY_WORKER_MAX_MEMORY_PER_CHILD_KB:-800000/);
  assert.match(planningLauncher, /CELERY_AUTO_LIVE_MAX_TASKS_PER_CHILD:-1/);
  assert.match(redeploy, /remove_obsolete_primary_worker_dropins/);
  assert.match(redeploy, /no-beat-queue\.conf/);
  assert.match(redeploy, /validate_primary_worker_launcher/);
  assert.match(productionDocs, /replaces\s+its only child after every completed run/);
  assert.match(auditDocs, /replaced after every completed task/);
});

test("changed Bullpen TypeScript files have no syntax diagnostics", () => {
  for (const relativePath of [
    "../auth.ts",
    "../app/api/auth/[...nextauth]/route.ts",
    "../app/api/bullpen-ai/_lib/backendBullpenRuntime.ts",
    "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
    "../app/api/bullpen-ai/positions/route.ts",
  ]) {
    assertTypeScriptParses(relativePath);
  }
});
