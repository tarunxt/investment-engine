import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const frontendDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function transpileTypeScript(relativePath, moduleKind = ts.ModuleKind.ESNext) {
  const source = read(relativePath);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: moduleKind,
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
  return result.outputText;
}

function loadTypeScriptModule(relativePath) {
  const output = transpileTypeScript(relativePath, ts.ModuleKind.CommonJS);
  const loaded = { exports: {} };
  const evaluate = new Function("exports", "module", "require", output);
  evaluate(loaded.exports, loaded, (specifier) => {
    throw new Error(`Unexpected runtime import while loading ${relativePath}: ${specifier}`);
  });
  return loaded.exports;
}

test("latest threat responses hydrate a bounded history with one snapshot query", () => {
  const zerodhaSource = read("../../backend/app/domains/zerodha/threats_router.py");
  const indmoneySource = read("../../backend/app/domains/indmoney_us/threats_router.py");

  for (const source of [zerodhaSource, indmoneySource]) {
    assert.match(source, /THREAT_HISTORY_AUGMENTATION_LIMIT = 50/);
    assert.match(source, /load_only\(\s*Job\.id,\s*Job\.user_id,\s*Job\.prompt/);
    assert.match(source, /parse_[a-z_]+_threat_urgent_actionables/);
    assert.match(
      source,
      /\.order_by\(Job\.id\.desc\(\)\)\s*\.limit\(THREAT_HISTORY_AUGMENTATION_LIMIT\)/,
    );
    assert.match(source, /jobs\.reverse\(\)/);
  }

  assert.match(
    zerodhaSource,
    /ZerodhaPortfolioSnapshot\.snapshot_date\.in_\(tuple\(snapshot_dates\)\)/,
  );
  assert.doesNotMatch(zerodhaSource, /await snapshot_repo\.get_by_user_and_date/);

  assert.match(
    indmoneySource,
    /IndMoneyUsPortfolioSnapshot\.id\.in_\(tuple\(snapshot_ids\)\)/,
  );
  assert.doesNotMatch(indmoneySource, /await snapshot_repo\.get_by_user_and_id/);
});

test("dashboard mount uses bounded summary-selected run details", () => {
  const actionablesSource = read(
    "../app/console/_components/FinalActionablesConsole.tsx",
  );
  const workflowSource = read(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
  );

  assert.match(
    actionablesSource,
    /export async function fetchDashboardRecentFullRuns\(\)/,
  );
  assert.match(
    actionablesSource,
    /apiService\.getRuns\(\{\s*page: 1,\s*limit: DASHBOARD_RECENT_RUN_SUMMARY_LIMIT,\s*summary: true,/,
  );
  assert.match(
    actionablesSource,
    /DASHBOARD_RECENT_RUN_DETAIL_LIMIT = 24/,
  );
  assert.match(actionablesSource, /apiService\.getRun\(runId\)/);
  assert.match(
    actionablesSource,
    /const \[allRuns, zerodhaOverview, indmoneyOverview\][\s\S]*?fetchDashboardRecentFullRuns\(\)/,
  );
  assert.match(
    workflowSource,
    /const loadLatestIdleStageInfo[\s\S]*?fetchDashboardRecentFullRuns\(\)/,
  );

  transpileTypeScript(
    "../app/console/_components/FinalActionablesConsole.tsx",
  );
  transpileTypeScript(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
  );
});

test("structured Bullpen errors become concise dashboard warnings", () => {
  const relativePath =
    "../app/console/dashboard/_components/dashboardOverviewUtils.ts";
  const { normalizeError } = loadTypeScriptModule(relativePath);
  assert.equal(typeof normalizeError, "function");

  const rawPayload = JSON.stringify({
    positions: [],
    liveAvailable: false,
    health: {
      message: "Bullpen runtime is unavailable.",
      actionNeeded: "Verify Bullpen auth in the backend runtime, then retry.",
    },
    error: "Backend request and tracked-position fallback both failed.",
  });
  const normalized = normalizeError(new Error(rawPayload));

  assert.equal(
    normalized,
    "Bullpen runtime is unavailable. Verify Bullpen auth in the backend runtime, then retry.",
  );
  assert.doesNotMatch(normalized, /[{}]/);
  assert.equal(
    normalizeError(new Error("Request timed out after 20000ms")),
    "Request timed out after 20000ms",
  );

  const detailedProviderError = `Provider rejected the request. ${"diagnostic context ".repeat(30)}`;
  assert.equal(
    normalizeError(new Error(detailedProviderError)),
    detailedProviderError.trim(),
    "the detailed dialog must receive the complete provider diagnostic",
  );
});

test("changed dashboard TypeScript and threat routers parse", () => {
  transpileTypeScript(
    "../app/console/dashboard/_components/dashboardOverviewUtils.ts",
  );

  execFileSync(
    "python3",
    [
      "-m",
      "py_compile",
      "backend/app/domains/zerodha/threats_router.py",
      "backend/app/domains/indmoney_us/threats_router.py",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PYTHONPYCACHEPREFIX: `${frontendDirectory}/.test-pycache`,
      },
      stdio: "pipe",
    },
  );
});


test("stage Duration opens a dedicated breakdown dialog without navigating the tile", () => {
  const workflowSource = read(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
  );
  const dialogSource = read(
    "../app/console/dashboard/_components/StageDurationBreakdownDialog.tsx",
  );

  assert.match(workflowSource, /row\.label === "Duration"/);
  assert.match(
    workflowSource,
    /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setDurationDialogOpen\(true\);/,
  );
  assert.match(workflowSource, /<StageDurationBreakdownDialog/);
  assert.match(workflowSource, /onClick\?\.\(\);/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /Stage setup and LLM dispatch/);
  assert.match(dialogSource, /LLM execution/);
  assert.match(dialogSource, /Validation, aggregation and finalisation/);
  assert.match(dialogSource, /providers run in parallel/);

  transpileTypeScript(
    "../app/console/dashboard/_components/StageDurationBreakdownDialog.tsx",
  );
});
