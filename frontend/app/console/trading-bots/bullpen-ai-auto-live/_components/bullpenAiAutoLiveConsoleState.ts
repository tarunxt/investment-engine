import type {
  BullpenAutoLiveSettings,
  BullpenAutoLiveState,
} from "@/types/api";

export type BullpenAiAutoLiveRunControlState = {
  liveModeRequested: boolean;
  disabled: boolean;
  label: string;
  reason: string | null;
};

export function deriveBullpenAiAutoLiveRunControlState({
  settings,
  state,
}: {
  settings: BullpenAutoLiveSettings | null;
  state: BullpenAutoLiveState | null;
}): BullpenAiAutoLiveRunControlState {
  const liveModeRequested = Boolean(
    settings && !settings.dry_run && settings.allow_live_execution,
  );

  if (!liveModeRequested) {
    return {
      liveModeRequested: false,
      disabled: false,
      label: "Run Rebalance Now",
      reason: null,
    };
  }

  let reason: string | null = null;
  if (!settings?.auto_live_enabled) {
    reason = "Auto-Live must be enabled before a live rebalance can run.";
  } else if (state?.emergency_stopped) {
    reason = "Emergency stop is active.";
  } else if (!state?.live_armed) {
    reason = "Live execution is not armed.";
  } else if (!state?.live_execution_allowed) {
    reason = "Live execution is not allowed until every runtime guardrail passes.";
  }

  return {
    liveModeRequested: true,
    disabled: reason !== null,
    label: "Run Live Rebalance Now",
    reason,
  };
}

