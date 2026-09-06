import type { BullpenScanFilters } from "@/lib/bullpen-ai";
import type { BullpenScanFilterDetailId } from "@/lib/bullpenScanExclusions";
import type { BullpenAutoLiveSettings } from "@/types/api";

export const BULLPEN_STAGE_ONE_SETTINGS_UPDATED_EVENT =
  "bullpen-stage-one-settings-updated";
export const BULLPEN_STAGE_ONE_REAPPLY_FILTERS_EVENT =
  "bullpen-stage-one-reapply-filters";
export const BULLPEN_STAGE_ONE_REAPPLY_FINISHED_EVENT =
  "bullpen-stage-one-reapply-finished";

export const BULLPEN_SCAN_FILTER_SETTING_KEYS = {
  excludeSports: "console_exclude_sports",
  excludeWeather: "console_exclude_weather",
  excludeMarketPredictions: "console_exclude_market_predictions",
  excludeTweetCountQuestions: "console_exclude_tweet_count_questions",
  excludeReleasedByEvents: "console_exclude_released_by_events",
  onlyBinaryYesNo: "console_only_binary_yes_no",
  excludeOthers: "console_exclude_custom_phrases",
} as const satisfies Record<
  BullpenScanFilterDetailId,
  keyof BullpenAutoLiveSettings
>;

export type BullpenScanFilterToggleState = Record<
  BullpenScanFilterDetailId,
  boolean
>;

export function getBullpenScanFilterToggles(
  settings: BullpenAutoLiveSettings,
): BullpenScanFilterToggleState {
  return {
    excludeSports: settings.console_exclude_sports ?? true,
    excludeWeather: settings.console_exclude_weather ?? true,
    excludeMarketPredictions:
      settings.console_exclude_market_predictions ?? true,
    excludeTweetCountQuestions:
      settings.console_exclude_tweet_count_questions ?? true,
    excludeReleasedByEvents:
      settings.console_exclude_released_by_events ?? true,
    onlyBinaryYesNo: settings.console_only_binary_yes_no ?? true,
    excludeOthers: settings.console_exclude_custom_phrases ?? true,
  };
}

export function applyBullpenStageOneSettings(
  filters: BullpenScanFilters,
  settings: BullpenAutoLiveSettings,
): BullpenScanFilters {
  const toggles = getBullpenScanFilterToggles(settings);
  return {
    ...filters,
    maxClosingDays: settings.console_max_closing_days ?? 30,
    minVolumeUsd: settings.console_min_volume_usd ?? 100,
    minLiquidityUsd: settings.console_min_liquidity_usd ?? 100,
    rejectedThemePattern:
      settings.console_rejected_theme_pattern ?? "crypto prices|twitter|Mentions",
    minYesOdds: 0,
    minNoOdds: 0,
    minLowerOutcomeOdds: settings.console_min_market_odds ?? 1,
    minHigherOutcomeOdds: settings.console_min_highest_market_odds ?? 90,
    excludeSports: toggles.excludeSports,
    excludeWeather: toggles.excludeWeather,
    excludeMarketPredictions: toggles.excludeMarketPredictions,
    excludeTweetCountQuestions: toggles.excludeTweetCountQuestions,
    excludeReleasedByEvents: toggles.excludeReleasedByEvents,
    onlyBinaryYesNo: toggles.onlyBinaryYesNo,
    customExcludeOtherPhrases: toggles.excludeOthers
      ? settings.console_custom_exclude_phrases ?? []
      : [],
  };
}
