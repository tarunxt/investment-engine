import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadModule(relativePath, fileName) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

async function loadRiskGuardrailsModule() {
  return loadModule(
    "../app/console/trading-bots/bullpen-ai-auto-live/_components/bullpenAiAutoLiveRiskGuardrails.ts",
    "bullpenAiAutoLiveRiskGuardrails.ts",
  );
}

async function loadConsoleStateModule() {
  return loadModule(
    "../app/console/trading-bots/bullpen-ai-auto-live/_components/bullpenAiAutoLiveConsoleState.ts",
    "bullpenAiAutoLiveConsoleState.ts",
  );
}

test("Bullpen AI Auto-Live guardrails expose safe defaults, reset draft, and JSON export", async () => {
  const {
    BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
    buildBullpenAiAutoLiveSafeDefaultDraft,
    bullpenAiAutoLiveSettingsToDraft,
    serializeBullpenAiAutoLiveGuardrails,
  } = await loadRiskGuardrailsModule();

  const safeDefaultDraft = buildBullpenAiAutoLiveSafeDefaultDraft();

  assert.equal(BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS.max_llm_spread_pp, 30);
  assert.equal(BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS.dry_run, true);
  assert.equal(BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS.allow_live_execution, false);
  assert.deepEqual(
    safeDefaultDraft,
    bullpenAiAutoLiveSettingsToDraft(BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS),
  );

  const exportedJson = serializeBullpenAiAutoLiveGuardrails(
    BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
  );
  const exported = JSON.parse(exportedJson);

  assert.equal(exported.auto_live_enabled, false);
  assert.equal(exported.limit_orders_only, true);
  assert.equal(exported.max_bid_ask_spread_cents, 5);
});

test("Bullpen AI Auto-Live guardrails validate editable settings and reject invalid combinations", async () => {
  const {
    BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
    bullpenAiAutoLiveSettingsToDraft,
    validateBullpenAiAutoLiveGuardrailDraft,
  } = await loadRiskGuardrailsModule();

  const editableDraft = bullpenAiAutoLiveSettingsToDraft(
    BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
  );
  editableDraft.bankroll_usd = "250";
  editableDraft.max_order_usd = "15";

  const valid = validateBullpenAiAutoLiveGuardrailDraft(editableDraft);
  assert.equal(valid.settings?.bankroll_usd, 250);
  assert.equal(valid.settings?.max_order_usd, 15);
  assert.deepEqual(valid.fieldErrors, {});

  const invalid = validateBullpenAiAutoLiveGuardrailDraft({
    ...editableDraft,
    max_single_trade_pct_bankroll: "7",
    max_single_market_pct_bankroll: "6",
    half_size_llm_spread_pp: "31",
    max_llm_spread_pp: "30",
  });

  assert.equal(invalid.settings, null);
  assert.match(
    invalid.fieldErrors.max_single_trade_pct_bankroll ?? "",
    /Single-trade cap/,
  );
  assert.match(
    invalid.fieldErrors.max_single_market_pct_bankroll ?? "",
    /Single-market cap/,
  );
  assert.match(
    invalid.fieldErrors.half_size_llm_spread_pp ?? "",
    /cannot exceed max LLM spread/,
  );
});

test("Run Live Rebalance Now disables until every live requirement passes, and emergency stop keeps live controls locked", async () => {
  const { deriveBullpenAiAutoLiveRunControlState } =
    await loadConsoleStateModule();

  const liveSettings = {
    auto_live_enabled: true,
    dry_run: false,
    allow_live_execution: true,
  };

  const blockedForArming = deriveBullpenAiAutoLiveRunControlState({
    settings: liveSettings,
    state: {
      live_armed: false,
      live_execution_allowed: false,
      emergency_stopped: false,
    },
  });
  assert.equal(blockedForArming.label, "Run Live Rebalance Now");
  assert.equal(blockedForArming.disabled, true);
  assert.match(blockedForArming.reason ?? "", /not armed/i);

  const blockedByEmergencyStop = deriveBullpenAiAutoLiveRunControlState({
    settings: liveSettings,
    state: {
      live_armed: true,
      live_execution_allowed: true,
      emergency_stopped: true,
    },
  });
  assert.equal(blockedByEmergencyStop.disabled, true);
  assert.match(blockedByEmergencyStop.reason ?? "", /Emergency stop/i);

  const readyForLiveRun = deriveBullpenAiAutoLiveRunControlState({
    settings: liveSettings,
    state: {
      live_armed: true,
      live_execution_allowed: true,
      emergency_stopped: false,
    },
  });
  assert.equal(readyForLiveRun.disabled, false);
  assert.equal(readyForLiveRun.reason, null);

  const dryRunState = deriveBullpenAiAutoLiveRunControlState({
    settings: {
      auto_live_enabled: true,
      dry_run: true,
      allow_live_execution: false,
    },
    state: null,
  });
  assert.equal(dryRunState.label, "Run Rebalance Now");
  assert.equal(dryRunState.disabled, false);
});

test("Auto-Live UI keeps explicit warning copy for live risk, role separation, and live enable confirmation", () => {
  const consoleSource = readFileSync(
    new URL(
      "../app/console/trading-bots/bullpen-ai-auto-live/_components/BullpenAiAutoLiveConsole.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const drawerSource = readFileSync(
    new URL(
      "../app/console/trading-bots/bullpen-ai-auto-live/_components/BullpenAiAutoLiveRiskGuardrailsDrawer.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    consoleSource,
    /Live trading can lose money\. This bot only executes when Auto-Live, live environment permission, Bullpen doctor, balance checks, and all guardrails pass\. Keep Dry Run enabled until tested\./,
  );
  assert.match(consoleSource, /Bullpen x AI = analysis/);
  assert.match(consoleSource, /Bullpen AI Auto-Live = automated execution/);
  assert.match(consoleSource, /Emergency Stop/);
  assert.match(
    drawerSource,
    /Type ENABLE LIVE to confirm\. This allows automated live orders subject to guardrails\./,
  );
});
