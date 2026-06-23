import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadInternetAccessModule() {
  const source = readFileSync(
    new URL("../lib/llmInternetAccess.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "llmInternetAccess.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

test("LLM internet access helper maps provider modes and web-capable filtering", async () => {
  const {
    countSelectedWebCapableModels,
    getInternetAccessBadgeText,
    getResolvedProviderInternetAccess,
    getWebCapableModelKeys,
  } = await loadInternetAccessModule();

  const providers = [
    {
      name: "openai",
      models: ["gpt-4o-mini"],
      internet_access: getResolvedProviderInternetAccess("openai"),
    },
    {
      name: "gemini",
      models: ["gemini-2.5-flash"],
      internet_access: getResolvedProviderInternetAccess("gemini"),
    },
    {
      name: "deepseek",
      models: ["deepseek-v4-flash"],
      internet_access: getResolvedProviderInternetAccess("deepseek"),
    },
    {
      name: "anthropic",
      models: ["claude-sonnet-4-6"],
      internet_access: getResolvedProviderInternetAccess("anthropic"),
    },
  ];

  assert.equal(
    getResolvedProviderInternetAccess("openai").mode,
    "conditional",
  );
  assert.equal(
    getInternetAccessBadgeText(getResolvedProviderInternetAccess("openai")),
    "🟡 Web if forced",
  );
  assert.equal(
    getInternetAccessBadgeText(getResolvedProviderInternetAccess("gemini")),
    "🌐 Live web",
  );
  assert.equal(
    getInternetAccessBadgeText(getResolvedProviderInternetAccess("deepseek")),
    "🌐 Web tool available",
  );
  assert.equal(
    getInternetAccessBadgeText(getResolvedProviderInternetAccess("anthropic")),
    "⚪ No live web",
  );

  assert.deepEqual(getWebCapableModelKeys(providers), [
    "openai::gpt-4o-mini",
    "gemini::gemini-2.5-flash",
    "deepseek::deepseek-v4-flash",
  ]);

  assert.equal(
    countSelectedWebCapableModels(
      providers,
      new Set([
        "openai::gpt-4o-mini",
        "gemini::gemini-2.5-flash",
        "deepseek::deepseek-v4-flash",
        "anthropic::claude-sonnet-4-6",
      ]),
    ),
    3,
  );
});

test("LLM model selection panel exposes the web-capable controls and badges", () => {
  const selectionPanelSource = readFileSync(
    new URL("../components/shared/LlmModelSelectionPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(selectionPanelSource, /Web-capable selected:/);
  assert.match(selectionPanelSource, /Select web-capable only/);
  assert.match(selectionPanelSource, /✅ Used web last run/);
  assert.match(selectionPanelSource, /⚠️ No sources last run/);
});
