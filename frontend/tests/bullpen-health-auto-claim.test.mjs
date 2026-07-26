import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const FRONTEND_ROOT =
  path.basename(process.cwd()) === "frontend"
    ? process.cwd()
    : path.resolve(process.cwd(), "frontend");
const BULLPEN_API_ROOT = path.join(FRONTEND_ROOT, "app", "api", "bullpen-ai");
const SOURCE_ROOTS = [
  path.join(FRONTEND_ROOT, "app"),
  path.join(FRONTEND_ROOT, "lib"),
];

function walkSourceFiles(rootDir) {
  const files = [];

  for (const entry of readdirSync(rootDir)) {
    const entryPath = path.join(rootDir, entry);
    const entryStat = statSync(entryPath);
    if (entryStat.isDirectory()) {
      files.push(...walkSourceFiles(entryPath));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
      files.push(entryPath);
    }
  }

  return files;
}

function encodeModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadBullpenPositionsRoute(fetchBackendRuntimeJsonImpl) {
  const routePath = path.join(BULLPEN_API_ROOT, "positions", "route.ts");
  const routeSource = readFileSync(routePath, "utf8");

  const nextServerStubUrl = encodeModule(`
    export class NextRequest {
      constructor(url, options = {}) {
        this.url = url;
        this.nextUrl = new URL(url);
        const cookieMap = new Map(Object.entries(options.cookies || {}));
        this.cookies = {
          get(name) {
            const value = cookieMap.get(name);
            return value === undefined ? undefined : { value };
          },
        };
      }
    }

    export const NextResponse = {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() {
            return body;
          },
        };
      },
    };
  `);
  const backendStubUrl = encodeModule(`
    export async function fetchBackendRuntimeJson(path, options = {}) {
      return globalThis.__bullpenFetchBackendRuntimeJson(path, options);
    }
  `);
  const backendSessionStubUrl = encodeModule(`
    export async function createBackendSessionContext(request) {
      return { request };
    }
    export async function fetchBackendJsonWithSession(_context, path, options = {}) {
      return globalThis.__bullpenFetchBackendRuntimeJson(path, options);
    }
    export function backendSessionJson(_context, body, init = {}) {
      return {
        status: init.status ?? 200,
        async json() {
          return body;
        },
      };
    }
  `);
  const healthCoreStubUrl = encodeModule(`
    export function redactBullpenSensitiveText(value) {
      return typeof value === "string" ? value : null;
    }
  `);
  const marketUrlsStubUrl = encodeModule(`
    export async function resolvePolymarketMarketsWithQuestionFallback() {
      return {};
    }
  `);
  const bullpenPositionsStubUrl = encodeModule(`
    export function aggregateBullpenCliPositions(rows) {
      return Array.isArray(rows) ? rows : [];
    }
    export function applyBullpenPositionMarketData(position) {
      return position;
    }
    export function buildBullpenPositionsDiagnostics() {
      return {
        excludedPositionCount: 0,
        diagnosticPositionCount: 0,
        settlementPendingCount: 0,
        staleOrUnknownCount: 0,
        closedPositionCount: 0,
        resolvedZeroPayoutCount: 0,
        settlementPendingPositions: [],
        diagnosticPositions: [],
        excludedPositions: [],
      };
    }
    export function buildTrackedBullpenPositionViews(rows) {
      return Array.isArray(rows) ? rows : [];
    }
    export function extractBullpenCliPositionRows(rows) {
      return Array.isArray(rows) ? rows : [];
    }
    export function filterDisplayBullpenPositions(rows) {
      return Array.isArray(rows) ? rows : [];
    }
    export function normalizeBullpenPosition(position) {
      return position;
    }
    export function summarizeBullpenPositions() {
      return {
        activeCount: 0,
        claimableCount: 0,
        claimableValue: 0,
        cashBalance: null,
        totalValue: null,
        unrealizedPnl: null,
        walletValue: null,
      };
    }
  `);

  const rewrittenSource = routeSource
    .replace(/from "next\/server"/g, `from "${nextServerStubUrl}"`)
    .replace(
      /from "\.\.\/_lib\/backendBullpenRuntime"/g,
      `from "${backendStubUrl}"`,
    )
    .replace(
      /from "\.\.\/_lib\/serverBackendSession"/g,
      `from "${backendSessionStubUrl}"`,
    )
    .replace(
      /from "\.\.\/_lib\/bullpenHealthCore\.ts"/g,
      `from "${healthCoreStubUrl}"`,
    )
    .replace(
      /from "\.\.\/_lib\/polymarketMarketUrls"/g,
      `from "${marketUrlsStubUrl}"`,
    )
    .replace(
      /from "@\/lib\/bullpenPositions"/g,
      `from "${bullpenPositionsStubUrl}"`,
    );
  const { outputText } = ts.transpileModule(rewrittenSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "route.ts",
  });

  globalThis.__bullpenFetchBackendRuntimeJson = fetchBackendRuntimeJsonImpl;
  return import(encodeModule(outputText));
}

test("frontend Bullpen routes proxy the backend runtime instead of spawning Bullpen locally", () => {
  const positionsRouteSource = readFileSync(
    path.join(BULLPEN_API_ROOT, "positions", "route.ts"),
    "utf8",
  );
  const healthRouteSource = readFileSync(
    path.join(BULLPEN_API_ROOT, "health", "route.ts"),
    "utf8",
  );
  const discoverRouteSource = readFileSync(
    path.join(BULLPEN_API_ROOT, "route.ts"),
    "utf8",
  );

  assert.match(positionsRouteSource, /fetchBackendJsonWithSession/);
  assert.match(positionsRouteSource, /createBackendSessionContext/);
  assert.match(positionsRouteSource, /\/polymarket\/runtime\/positions/);
  assert.match(healthRouteSource, /\/polymarket\/runtime\/health/);
  assert.match(discoverRouteSource, /\/polymarket\/runtime\/discover/);
  assert.doesNotMatch(positionsRouteSource, /syncBullpenLiveSnapshot/);
  assert.doesNotMatch(positionsRouteSource, /readLastSuccessfulBullpenLiveSnapshot/);
});

test("frontend positions polling calls only the backend positions runtime endpoint", async () => {
  const backendCalls = [];
  const { GET } = await loadBullpenPositionsRoute(async (path) => {
    backendCalls.push(path);
    if (!path.startsWith("/polymarket/runtime/positions")) {
      throw new Error(`Unexpected backend runtime path: ${path}`);
    }
    return {
      ok: true,
      snapshot: {
        payload: { positions: [], summary: {} },
        fetched_at: "2026-07-19T12:00:00+00:00",
        cli_version: "bullpen 0.1.115",
        auth_checked_at: "2026-07-19T11:59:00+00:00",
        source: "live-cli",
        freshness_state: "fresh",
        diagnostics: {
          effective_home: "/home/investor",
          bullpen_version: "bullpen 0.1.115",
          error_classification: null,
        },
      },
      broker_health: {
        ok: true,
        checked_at: "2026-07-19T12:00:00+00:00",
        message: "Cached broker health is ready.",
        command_path: "/usr/local/bin/bullpen",
        effective_home: "/home/investor",
      },
      auth_checked_at: "2026-07-19T11:59:00+00:00",
      cli_version: "bullpen 0.1.115",
    };
  });

  const response = await GET({
    nextUrl: new URL("http://testserver/api/bullpen-ai/positions?max_age_seconds=20"),
    cookies: {
      get() {
        return undefined;
      },
    },
  });
  const payload = await response.json();

  assert.deepEqual(backendCalls, [
    "/polymarket/runtime/positions?force_fresh=false&max_age_seconds=20&caller_source=frontend-passive&passive=true",
  ]);
  assert.equal(payload.liveAvailable, true);
  assert.equal(payload.positionsSource, "live-cli");
  assert.equal(payload.health?.message, "Bullpen live wallet snapshot is ready.");
});

test("frontend source tree contains no Bullpen child_process or execFile runtime usage", () => {
  const sourceFiles = SOURCE_ROOTS.flatMap((rootDir) => walkSourceFiles(rootDir));
  const offenders = [];

  for (const sourceFile of sourceFiles) {
    const source = readFileSync(sourceFile, "utf8");
    if (/node:child_process/.test(source)) {
      offenders.push(`${sourceFile}: node:child_process import`);
    }
    if (/\bpromisify\s*\(\s*execFile\s*\)/.test(source)) {
      offenders.push(`${sourceFile}: promisify(execFile)`);
    }
    if (/\bexecFileAsync\s*\(/.test(source)) {
      offenders.push(`${sourceFile}: execFileAsync(...)`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("legacy frontend Bullpen runtime helper was removed", () => {
  const legacyHelperPath = path.join(
    BULLPEN_API_ROOT,
    "_lib",
    "bullpenHealth.ts",
  );

  assert.throws(() => statSync(legacyHelperPath));
});
