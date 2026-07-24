import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

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
    errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
  );
  return result.outputText;
}

function loadUrlsModule() {
  const output = transpileTypeScript("../lib/urls.ts", ts.ModuleKind.CommonJS);
  const module = { exports: {} };
  const evaluate = new Function(
    "exports",
    "module",
    "require",
    "process",
    output,
  );
  evaluate(
    module.exports,
    module,
    (specifier) => {
      if (specifier === "@/services/session") {
        return { sessionStorage: { getUserData: () => null } };
      }
      throw new Error(`Unexpected runtime import: ${specifier}`);
    },
    {
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "https://api.cred-x.in",
      },
    },
  );
  return module.exports;
}

test("browser API reads use the public API before the same-origin proxy", () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: {
      hostname: "cred-x.in",
      origin: "https://cred-x.in",
      protocol: "https:",
    },
  };

  try {
    const { resolveApiReadTransportCandidates } = loadUrlsModule();
    const candidates = resolveApiReadTransportCandidates(
      "https://api.cred-x.in/runs?page=1&limit=100",
    );
    assert.deepEqual(candidates, [
      {
        url: "https://api.cred-x.in/runs?page=1&limit=100",
        stage: "primary",
        transport: "configured-or-inferred-api",
      },
      {
        url: "https://cred-x.in/backend-api/runs?page=1&limit=100",
        stage: "secondary",
        transport: "same-origin-proxy",
      },
    ]);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("server proxy fallbacks are bounded and mutations execute only once", () => {
  const source = read("../app/backend-api/[...path]/route.ts");

  assert.match(source, /stage: "primary"/);
  assert.match(source, /stage: "secondary"/);
  assert.match(source, /stage: "tertiary" as const/);
  assert.match(source, /DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 3_000/);
  assert.match(source, /SAFE_FALLBACK_METHODS = new Set\(\["GET", "HEAD"\]\)/);
  assert.match(
    source,
    /SAFE_FALLBACK_METHODS\.has\(request\.method\)[\s\S]*resolvedCandidates[\s\S]*resolvedCandidates\.slice\(0, 1\)/,
  );
  assert.match(source, /backend_api_proxy_fallback_triggered/);
});

test("API reads validate payloads, deduplicate requests, and avoid retry loops", () => {
  const source = read("../services/api.ts");

  assert.match(source, /InvalidAPIResponseError/);
  assert.match(source, /resolveApiReadTransportCandidates\(url\)/);
  assert.match(source, /private readonly inFlightReads = new Map/);
  assert.match(source, /api_read_fallback_triggered/);
  assert.doesNotMatch(source, /READ_RETRY_DELAYS_MS/);
  assert.doesNotMatch(source, /while \(true\)/);
});

test("dashboard tertiary fallbacks validate age-bounded saved data", () => {
  const dashboardSource = read("../app/console/dashboard/page.tsx");
  const actionablesSource = read(
    "../app/console/_components/FinalActionablesConsole.tsx",
  );

  assert.match(dashboardSource, /isValidDashboardCacheValue/);
  assert.match(dashboardSource, /dashboard_read_fallback_triggered/);
  assert.match(dashboardSource, /last-known-good-cache/);
  assert.match(dashboardSource, /dashboard_refresh_deduplicated/);
  assert.match(actionablesSource, /DASHBOARD_FINAL_ACTIONABLES_CACHE_MAX_AGE_MS/);
  assert.match(actionablesSource, /final_actionables_fallback_triggered/);
  assert.match(actionablesSource, /final_actionables_refresh_deduplicated/);
});

test("changed fallback TypeScript modules parse", () => {
  for (const relativePath of [
    "../lib/urls.ts",
    "../services/api.ts",
    "../app/backend-api/[...path]/route.ts",
    "../app/console/dashboard/page.tsx",
    "../app/console/_components/FinalActionablesConsole.tsx",
  ]) {
    transpileTypeScript(relativePath);
  }
});
