import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve as resolvePath } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const FRONTEND_ROOT = fileURLToPath(new URL("../", import.meta.url));
const moduleCache = new Map();

function resolveModuleFilePath(specifier, parentFilePath) {
  const basePath = specifier.startsWith("@/")
    ? resolvePath(FRONTEND_ROOT, specifier.slice(2))
    : resolvePath(dirname(parentFilePath), specifier);
  const candidates = extname(basePath)
    ? [basePath]
    : [
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.mjs`,
        resolvePath(basePath, "index.ts"),
        resolvePath(basePath, "index.tsx"),
        resolvePath(basePath, "index.js"),
        resolvePath(basePath, "index.mjs"),
      ];

  const resolvedPath = candidates.find((candidate) => existsSync(candidate));
  if (!resolvedPath) {
    throw new Error(`Unable to resolve module "${specifier}" from ${parentFilePath}`);
  }

  return resolvedPath;
}

function loadTsModule(moduleFilePath) {
  const cached = moduleCache.get(moduleFilePath);
  if (cached) return cached.exports;

  const source = readFileSync(moduleFilePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: moduleFilePath,
  });

  const moduleObj = { exports: {} };
  moduleCache.set(moduleFilePath, moduleObj);

  const localRequire = (specifier) => {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@/")) {
      return loadTsModule(resolveModuleFilePath(specifier, moduleFilePath));
    }
    return require(specifier);
  };

  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: localRequire,
    __dirname: dirname(moduleFilePath),
    __filename: moduleFilePath,
    console,
    process,
    Buffer,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    setTimeout,
    fetch: globalThis.fetch,
  });
  const script = new vm.Script(outputText, {
    filename: moduleFilePath,
  });
  script.runInContext(context);

  return moduleObj.exports;
}

function loadCategoryModule() {
  return loadTsModule(
    fileURLToPath(
      new URL("../app/api/bullpen-ai/_lib/polymarketCategory.ts", import.meta.url),
    ),
  );
}

function loadPolymarketMarketUrlsModule() {
  return loadTsModule(
    fileURLToPath(
      new URL(
        "../app/api/bullpen-ai/_lib/polymarketMarketUrls.ts",
        import.meta.url,
      ),
    ),
  );
}

function createQuestion(overrides = {}) {
  return {
    id: "Q1",
    question: "Will Iran announce withdrawal from MOU negotiations by July 31?",
    closeTime: "2026-07-31T23:59:00.000Z",
    category: "Uncategorized",
    yesOdds: 8.5,
    noOdds: 91.5,
    volume: "$1,000",
    liquidity: "$500",
    sourceUrl: "https://example.com/source",
    slug: "iran-announces-withdrawal-from-mou-negotiations-byptptpt-20260622191732319",
    marketUrl:
      "https://polymarket.com/event/iran-announces-withdrawal-from-mou-negotiations-byptptpt-20260622191732319",
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: 20,
    rules: null,
    marketContext: null,
    resolutionSource: null,
    ...overrides,
  };
}

test("Polymarket market resolution preserves open, closed, and unknown states", () => {
  const { resolveAuthoritativeMarketOpenState } =
    loadPolymarketMarketUrlsModule();

  assert.equal(
    resolveAuthoritativeMarketOpenState({ active: true, closed: false }),
    true,
  );
  assert.equal(
    resolveAuthoritativeMarketOpenState({ active: false, closed: false }),
    false,
  );
  assert.equal(
    resolveAuthoritativeMarketOpenState({ active: null, closed: null }),
    null,
  );
});

test("collectPolymarketCategoryLabels extracts ordered nested event labels and skips Uncategorized", () => {
  const { collectPolymarketCategoryLabels } = loadCategoryModule();

  const labels = collectPolymarketCategoryLabels({
    category: "Uncategorized",
    tags: [{ label: "Politics" }, { label: "Uncategorized" }],
    categories: ["Politics", ""],
    events: [
      {
        category: "",
        tags: [{ label: "Iran" }, { label: "Uncategorized" }],
        categories: ["Iran", "Uncategorized"],
      },
    ],
  });

  assert.deepEqual(Array.from(labels), ["Politics", "Iran"]);
});

test("shouldReplaceCategory only upgrades to richer Polymarket category trails", () => {
  const { shouldReplaceCategory } = loadCategoryModule();

  assert.equal(
    shouldReplaceCategory("Uncategorized", "Politics · Iran"),
    true,
  );
  assert.equal(
    shouldReplaceCategory("Politics", "Politics · Iran"),
    true,
  );
  assert.equal(
    shouldReplaceCategory("Politics · Iran", "Uncategorized"),
    false,
  );
});

test("inferPolymarketCategoryFromText assigns proper fallback labels for sportsbook-style props", () => {
  const { inferPolymarketCategoryFromText } = loadCategoryModule();

  assert.equal(
    inferPolymarketCategoryFromText("Achraf Hakimi: 1+ assists"),
    "Sports",
  );
  assert.equal(
    inferPolymarketCategoryFromText("Western Maharashtra floods by July 10?"),
    "Weather",
  );
  assert.equal(
    inferPolymarketCategoryFromText("Will Iran announce withdrawal from MOU negotiations?"),
    "Politics",
  );
});

test("applyCanonicalPolymarketMarketUrls upgrades Uncategorized categories from resolver metadata", async () => {
  const { applyCanonicalPolymarketMarketUrls } =
    loadPolymarketMarketUrlsModule();

  const questions = [createQuestion()];
  const nextQuestions = await applyCanonicalPolymarketMarketUrls(
    questions,
    async () => ({
      Q1: {
        id: "Q1",
        slug: questions[0].slug,
        marketUrl: questions[0].marketUrl,
        category: "Politics · Iran",
        yesOdds: questions[0].yesOdds,
        noOdds: questions[0].noOdds,
        bestBidPrice: null,
        bestAskPrice: null,
        rules: null,
        marketContext: null,
        resolutionSource: null,
      },
    }),
  );

  assert.equal(nextQuestions[0].category, "Politics · Iran");
});

test("applyCanonicalPolymarketMarketUrls replaces Uncategorized with inferred category when resolver lacks metadata", async () => {
  const { applyCanonicalPolymarketMarketUrls } =
    loadPolymarketMarketUrlsModule();

  const questions = [
    createQuestion({
      question: "Achraf Hakimi: 1+ assists",
      slug: "achraf-hakimi-1-assists",
    }),
  ];
  const nextQuestions = await applyCanonicalPolymarketMarketUrls(
    questions,
    async () => ({
      Q1: {
        id: "Q1",
        slug: questions[0].slug,
        marketUrl: questions[0].marketUrl,
        category: null,
        yesOdds: questions[0].yesOdds,
        noOdds: questions[0].noOdds,
        bestBidPrice: null,
        bestAskPrice: null,
        rules: null,
        marketContext: null,
        resolutionSource: null,
      },
    }),
  );

  assert.equal(nextQuestions[0].category, "Sports");
});

test("applyCanonicalPolymarketMarketUrls does not overwrite valid categories with missing resolver categories", async () => {
  const { applyCanonicalPolymarketMarketUrls } =
    loadPolymarketMarketUrlsModule();

  const questions = [
    createQuestion({
      category: "Politics · Iran",
    }),
  ];
  const nextQuestions = await applyCanonicalPolymarketMarketUrls(
    questions,
    async () => ({
      Q1: {
        id: "Q1",
        slug: questions[0].slug,
        marketUrl: questions[0].marketUrl,
        category: null,
        yesOdds: questions[0].yesOdds,
        noOdds: questions[0].noOdds,
        bestBidPrice: null,
        bestAskPrice: null,
        rules: null,
        marketContext: null,
        resolutionSource: null,
      },
    }),
  );

  assert.equal(nextQuestions[0].category, "Politics · Iran");
});
