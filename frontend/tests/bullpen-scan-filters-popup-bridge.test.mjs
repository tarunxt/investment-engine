import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridgeSource = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenScanFiltersPopupBridge.tsx",
    import.meta.url,
  ),
  "utf8",
);
const shellSource = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAiPageShell.tsx",
    import.meta.url,
  ),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../lib/bullpenStageOneSettings.ts", import.meta.url),
  "utf8",
);

test("Bullpen Stage 1 Filters trigger opens a popup even when legacy scan controls are not rendered", () => {
  assert.match(
    bridgeSource,
    /button\[aria-label=\"Open scan filters\"\]/,
  );
  assert.match(bridgeSource, /setIsOpen\(true\)/);
  assert.match(bridgeSource, /aria-labelledby="bullpen-stage-one-scan-filters-title"/);
  assert.match(bridgeSource, />\s*Scan Filters\s*</);
  assert.match(bridgeSource, /console_min_market_odds/);
  assert.match(bridgeSource, /useState\(1\)/);
  assert.match(bridgeSource, /console_min_market_odds \?\? 1/);
  assert.match(bridgeSource, /console_min_highest_market_odds \?\? 90/);
  assert.doesNotMatch(bridgeSource, /default 5%/);
  assert.match(bridgeSource, /console_max_closing_days/);
  assert.match(bridgeSource, /console_min_volume_usd/);
  assert.match(bridgeSource, /console_min_liquidity_usd/);
  assert.match(bridgeSource, /console_rejected_theme_pattern/);
  assert.match(bridgeSource, />\s*Volume \(USD\) &gt;\s*</);
  assert.match(bridgeSource, />\s*Liquidity \(USD\) &gt;\s*</);
  assert.match(bridgeSource, /crypto prices\|twitter\|Mentions/);
  assert.match(bridgeSource, /"Reapply Filters"/);
  assert.match(bridgeSource, /bg-blue-600/);
  assert.match(bridgeSource, /bg-slate-400/);
  assert.match(bridgeSource, /BULLPEN_STAGE_ONE_REAPPLY_FILTERS_EVENT/);
  assert.match(bridgeSource, />\s*Maximum days until expiry\s*</);
  assert.match(bridgeSource, /Save window/);
  assert.match(bridgeSource, /Save thresholds/);
  assert.match(bridgeSource, /Minimum value of min\(Yes, No Odds\)/);
  assert.match(bridgeSource, /Minimum value of max\(Yes, No Odds\)/);
  assert.doesNotMatch(bridgeSource, /Default: <code>crypto prices/);
  assert.match(bridgeSource, /updateBullpenAutoLiveSettings/);
  assert.match(bridgeSource, /console_custom_exclude_phrases/);
  assert.match(bridgeSource, /excludeOthers/);
  assert.match(bridgeSource, /type="checkbox"/);
  assert.match(bridgeSource, /checked=\{enabled\}/);
  assert.match(bridgeSource, /saveFilterToggle\(id, event\.target\.checked\)/);
  assert.match(bridgeSource, /Apply \$\{detail\.label\} filter/);
  assert.match(bridgeSource, /every future Trending and Full Universe scan/);
  assert.match(settingsSource, /console_exclude_sports/);
  assert.match(settingsSource, /console_exclude_weather/);
  assert.match(settingsSource, /console_exclude_market_predictions/);
  assert.match(settingsSource, /console_exclude_tweet_count_questions/);
  assert.match(settingsSource, /console_exclude_released_by_events/);
  assert.match(settingsSource, /console_only_binary_yes_no/);
  assert.match(settingsSource, /console_exclude_custom_phrases/);
});

test("Bullpen page shell always mounts the scan filter popup bridge", () => {
  assert.match(shellSource, /import \{ BullpenScanFiltersPopupBridge \}/);
  assert.match(shellSource, /<BullpenScanFiltersPopupBridge \/>/);
});
