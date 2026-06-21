"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { URLs } from "@/lib/urls";
import { cn } from "@/lib/utils";

import {
  AUTO_LIVE_ACTIVE_ROWS,
  AUTO_LIVE_CANDIDATE_ROWS,
  AUTO_LIVE_STAGE_FLOW,
  type AutoLiveCheckStatus,
  type AutoLiveDecision,
  type AutoLiveRiskStatus,
} from "./bullpenAiAutoLiveData";

type ReadinessKey =
  | "autoLiveEnabled"
  | "dryRun"
  | "liveExecutionEnv"
  | "doctorPasses"
  | "balanceReady"
  | "riskSettingsValid"
  | "emergencyStop";

type ControlState = {
  autoLiveEnabled: boolean;
  dryRun: boolean;
  liveExecutionEnv: boolean;
  doctorPasses: boolean;
  balanceReady: boolean;
  riskSettingsValid: boolean;
  emergencyStop: boolean;
  paused: boolean;
  liveTrading: boolean;
  lastAction: string;
  lastScan: string | null;
  lastLlmRun: string | null;
  lastRebalance: string | null;
  nextScan: string | null;
  nextLlmRun: string | null;
  nextRebalance: string | null;
};

type StatusTone = "default" | "positive" | "warning" | "critical";

type EmptyStateDescriptor = {
  title: string;
  description: string;
  tone: StatusTone;
};

const BANKROLL_USD = 25_000;
const CASH_RESERVE_USD = 5_000;

const READINESS_FIELDS: {
  key: ReadinessKey;
  label: string;
  helper: string;
}[] = [
  {
    key: "autoLiveEnabled",
    label: "Auto-live enabled",
    helper: "Master toggle for the automation engine.",
  },
  {
    key: "dryRun",
    label: "Dry run",
    helper: "Keeps scans and sizing live while blocking execution.",
  },
  {
    key: "liveExecutionEnv",
    label: "Live execution env",
    helper: "Requires the backend execution flag before live orders can route.",
  },
  {
    key: "doctorPasses",
    label: "Doctor passes",
    helper: "Execution doctor must validate auth, quotes, and venue health.",
  },
  {
    key: "balanceReady",
    label: "Balance ready",
    helper: "Wallet balance must be refreshed before trading.",
  },
  {
    key: "riskSettingsValid",
    label: "Risk settings valid",
    helper: "Guardrail config has to be complete and internally consistent.",
  },
  {
    key: "emergencyStop",
    label: "Emergency stop",
    helper: "Hard block for all live order submission.",
  },
];

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function createTimelineSnapshot(now = new Date()) {
  return {
    lastScan: new Date(now.getTime() - 12 * 60_000).toISOString(),
    lastLlmRun: new Date(now.getTime() - 8 * 60_000).toISOString(),
    lastRebalance: new Date(now.getTime() - 34 * 60_000).toISOString(),
    nextScan: new Date(now.getTime() + 7 * 60_000).toISOString(),
    nextLlmRun: new Date(now.getTime() + 15 * 60_000).toISOString(),
    nextRebalance: new Date(now.getTime() + 38 * 60_000).toISOString(),
  };
}

function getStatusClass(status: AutoLiveCheckStatus) {
  switch (status) {
    case "pass":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "fail":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "watch":
    default:
      return "border-amber-200 bg-amber-50 text-amber-800";
  }
}

function getDecisionClass(decision: AutoLiveDecision) {
  switch (decision) {
    case "BUY_NEW":
    case "ADD_MORE":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "HOLD":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "TRIM":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "EXIT":
    case "SKIP":
    default:
      return "border-rose-200 bg-rose-50 text-rose-700";
  }
}

function getRiskStatusClass(status: AutoLiveRiskStatus) {
  switch (status) {
    case "Ready":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "Blocked":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "Watch":
    default:
      return "border-amber-200 bg-amber-50 text-amber-800";
  }
}

function getToneClass(tone: StatusTone) {
  switch (tone) {
    case "positive":
      return "border-emerald-200 bg-emerald-50/80 text-emerald-900";
    case "warning":
      return "border-amber-200 bg-amber-50/80 text-amber-900";
    case "critical":
      return "border-rose-200 bg-rose-50/80 text-rose-900";
    case "default":
    default:
      return "border-slate-200 bg-slate-50/80 text-slate-900";
  }
}

export function BullpenAiAutoLiveConsole() {
  const [controlState, setControlState] = useState<ControlState>(() => ({
    autoLiveEnabled: true,
    dryRun: false,
    liveExecutionEnv: true,
    doctorPasses: true,
    balanceReady: true,
    riskSettingsValid: true,
    emergencyStop: false,
    paused: false,
    liveTrading: false,
    lastAction:
      "Auto-Live is armed. Live orders still require an explicit rebalance trigger.",
    ...createTimelineSnapshot(),
  }));
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({
    "iran-fifa-2026": true,
  });

  const canRunLiveRebalance =
    controlState.autoLiveEnabled &&
    !controlState.dryRun &&
    controlState.liveExecutionEnv &&
    !controlState.emergencyStop &&
    controlState.doctorPasses &&
    controlState.balanceReady &&
    controlState.riskSettingsValid;

  const liveBlockers = [
    !controlState.autoLiveEnabled ? "auto-live is disabled" : null,
    controlState.dryRun ? "dry-run is still enabled" : null,
    !controlState.liveExecutionEnv ? "live execution env flag is off" : null,
    controlState.emergencyStop ? "emergency stop is active" : null,
    !controlState.doctorPasses ? "doctor failed" : null,
    !controlState.balanceReady ? "balance is unavailable" : null,
    !controlState.riskSettingsValid ? "risk settings are invalid" : null,
  ].filter(Boolean) as string[];

  const activeRows = useMemo(() => {
    if (!controlState.autoLiveEnabled || controlState.dryRun) return [];
    return AUTO_LIVE_ACTIVE_ROWS;
  }, [controlState.autoLiveEnabled, controlState.dryRun]);

  const candidateRows = useMemo(() => {
    if (!controlState.autoLiveEnabled || controlState.paused) return [];
    return AUTO_LIVE_CANDIDATE_ROWS;
  }, [controlState.autoLiveEnabled, controlState.paused]);

  const displayRows = useMemo(
    () => [...activeRows, ...candidateRows],
    [activeRows, candidateRows],
  );

  const openExposure = activeRows.reduce(
    (total, row) => total + row.currentExposure,
    0,
  );
  const availableCash = Math.max(
    0,
    BANKROLL_USD - CASH_RESERVE_USD - openExposure,
  );
  const dailyPnl =
    !controlState.autoLiveEnabled
      ? 0
      : controlState.liveTrading
        ? 286
        : controlState.dryRun
          ? 42
          : 173;
  const weeklyPnl =
    !controlState.autoLiveEnabled
      ? 0
      : controlState.liveTrading
        ? 834
        : controlState.dryRun
          ? 154
          : 612;
  const tradesToday =
    !controlState.autoLiveEnabled
      ? 0
      : controlState.liveTrading
        ? 8
        : controlState.dryRun
          ? 3
          : 5;

  const emptyStates = useMemo(() => {
    const states: EmptyStateDescriptor[] = [];

    if (!controlState.autoLiveEnabled) {
      states.push({
        title: "Bot not configured",
        description:
          "Auto-live is disabled, so this console is holding position and candidate rows until the bot is armed again.",
        tone: "default",
      });
      return states;
    }

    if (controlState.dryRun) {
      states.push({
        title: "Dry run only",
        description:
          "Scans, evidence refreshes, and sizing still run, but no active live positions are surfaced for execution.",
        tone: "warning",
      });
    }

    if (!canRunLiveRebalance && !controlState.dryRun) {
      states.push({
        title: "Live blocked due to guardrails",
        description: `Live rebalance remains disabled because ${liveBlockers.join(
          ", ",
        )}.`,
        tone: "critical",
      });
    }

    if (activeRows.length === 0) {
      states.push({
        title: "No active positions yet",
        description:
          "This board is waiting for live execution to create or sync current Auto-Live positions.",
        tone: controlState.dryRun ? "warning" : "default",
      });
    }

    if (candidateRows.length === 0) {
      states.push({
        title: "No candidates yet",
        description:
          "New candidate markets will appear after the next successful scan and LLM consensus cycle.",
        tone: controlState.paused ? "warning" : "default",
      });
    }

    return states;
  }, [
    activeRows.length,
    candidateRows.length,
    canRunLiveRebalance,
    controlState.autoLiveEnabled,
    controlState.dryRun,
    controlState.paused,
    liveBlockers,
  ]);

  const guardrailItems = useMemo(() => {
    const maxThemeExposure = 4_500;
    const macroThemeExposure = activeRows
      .filter((row) => row.category.includes("Macro"))
      .reduce((total, row) => total + row.targetExposure, 0);
    const hasWideDisagreement = displayRows.some(
      (row) => row.llmConsensus.spread > 11,
    );

    return [
      {
        label: "Max single trade",
        value: "$1,250 cap",
        status: "pass" as const,
      },
      {
        label: "Max market exposure",
        value: "$3,000 / market",
        status: "pass" as const,
      },
      {
        label: "Max theme exposure",
        value: `${formatMoney(macroThemeExposure)} of ${formatMoney(maxThemeExposure)}`,
        status: macroThemeExposure > maxThemeExposure ? ("fail" as const) : ("pass" as const),
      },
      {
        label: "Max open exposure",
        value: `${formatMoney(openExposure)} live`,
        status:
          openExposure > 10_000
            ? ("fail" as const)
            : openExposure > 8_000
              ? ("watch" as const)
              : ("pass" as const),
      },
      {
        label: "Cash reserve",
        value: `${formatMoney(availableCash)} free after reserve`,
        status:
          controlState.balanceReady && availableCash >= 0
            ? ("pass" as const)
            : ("fail" as const),
      },
      {
        label: "Min edge",
        value: ">= 6 pts",
        status: displayRows.some((row) => row.edge < 6) ? ("watch" as const) : ("pass" as const),
      },
      {
        label: "Max LLM disagreement",
        value: hasWideDisagreement ? "Breached on 1 candidate" : "<= 11 pts spread",
        status: hasWideDisagreement ? ("watch" as const) : ("pass" as const),
      },
      {
        label: "Evidence requirement",
        value: "3 fresh shared sources",
        status: controlState.riskSettingsValid ? ("pass" as const) : ("fail" as const),
      },
      {
        label: "Daily/weekly loss stop",
        value: `${formatMoney(dailyPnl)} / ${formatMoney(weeklyPnl)}`,
        status: dailyPnl < -600 || weeklyPnl < -1500 ? ("fail" as const) : ("pass" as const),
      },
      {
        label: "Limit orders only",
        value: "Enabled",
        status: "pass" as const,
      },
      {
        label: "Emergency stop status",
        value: controlState.emergencyStop ? "Active" : "Clear",
        status: controlState.emergencyStop ? ("fail" as const) : ("pass" as const),
      },
    ];
  }, [
    activeRows,
    availableCash,
    controlState.balanceReady,
    controlState.emergencyStop,
    controlState.riskSettingsValid,
    dailyPnl,
    displayRows,
    openExposure,
    weeklyPnl,
  ]);

  const metricItems = [
    {
      label: "Bankroll",
      value: formatMoney(BANKROLL_USD),
      helper: "Configured bot bankroll",
    },
    {
      label: "Available cash",
      value: formatMoney(availableCash),
      helper: "Free cash after reserve",
    },
    {
      label: "Open exposure",
      value: formatMoney(openExposure),
      helper: "Current live position exposure",
    },
    {
      label: "Cash reserve",
      value: formatMoney(CASH_RESERVE_USD),
      helper: "Protected reserve floor",
    },
    {
      label: "Daily P&L",
      value: formatMoney(dailyPnl),
      helper: "Session contribution",
      tone: dailyPnl >= 0 ? "positive" : "negative",
    },
    {
      label: "Weekly P&L",
      value: formatMoney(weeklyPnl),
      helper: "Rolling 7-day contribution",
      tone: weeklyPnl >= 0 ? "positive" : "negative",
    },
    {
      label: "Active positions",
      value: formatNumber(activeRows.length),
      helper: "Live rows on-book",
    },
    {
      label: "Trades today",
      value: formatNumber(tradesToday),
      helper: "Executed or staged decisions",
    },
    {
      label: "Last scan",
      value: formatDateTime(controlState.lastScan),
      helper: "Market inventory refresh",
    },
    {
      label: "Last LLM run",
      value: formatDateTime(controlState.lastLlmRun),
      helper: "Consensus pipeline refresh",
    },
    {
      label: "Last rebalance",
      value: formatDateTime(controlState.lastRebalance),
      helper: "Most recent live or staged rebalance",
    },
    {
      label: "Next scan",
      value: formatDateTime(controlState.nextScan),
      helper: "Upcoming scan schedule",
    },
    {
      label: "Next LLM run",
      value: formatDateTime(controlState.nextLlmRun),
      helper: "Upcoming consensus refresh",
    },
    {
      label: "Next rebalance",
      value: formatDateTime(controlState.nextRebalance),
      helper: "Next live execution window",
    },
  ];

  const modeBadges = [
    {
      label: "Dry Run",
      active: controlState.dryRun,
      activeClass: "border-amber-200 bg-amber-50 text-amber-800",
    },
    {
      label: "Live Armed",
      active:
        controlState.autoLiveEnabled &&
        !controlState.dryRun &&
        !controlState.liveTrading &&
        !controlState.paused &&
        !controlState.emergencyStop &&
        controlState.liveExecutionEnv &&
        controlState.doctorPasses &&
        controlState.balanceReady &&
        controlState.riskSettingsValid,
      activeClass: "border-sky-200 bg-sky-50 text-sky-700",
    },
    {
      label: "Live Trading",
      active: controlState.liveTrading,
      activeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
    },
    {
      label: "Paused",
      active: controlState.paused,
      activeClass: "border-slate-300 bg-slate-100 text-slate-700",
    },
    {
      label: "Emergency Stopped",
      active: controlState.emergencyStop,
      activeClass: "border-rose-200 bg-rose-50 text-rose-700",
    },
    {
      label: "Doctor Failed",
      active: !controlState.doctorPasses,
      activeClass: "border-rose-200 bg-rose-50 text-rose-700",
    },
    {
      label: "Balance Unavailable",
      active: !controlState.balanceReady,
      activeClass: "border-amber-200 bg-amber-50 text-amber-800",
    },
  ];

  function setLastAction(message: string, updates?: Partial<ControlState>) {
    setControlState((current) => ({
      ...current,
      ...updates,
      lastAction: message,
    }));
  }

  function toggleReadiness(key: ReadinessKey) {
    setControlState((current) => {
      const nextValue = !current[key];
      const nextState: ControlState = {
        ...current,
        [key]: nextValue,
      };

      if (key === "dryRun" && nextValue) {
        nextState.liveTrading = false;
      }

      if (
        key === "emergencyStop" &&
        nextValue
      ) {
        nextState.liveTrading = false;
        nextState.paused = false;
      }

      if (
        (key === "doctorPasses" ||
          key === "balanceReady" ||
          key === "riskSettingsValid" ||
          key === "liveExecutionEnv") &&
        !nextValue
      ) {
        nextState.liveTrading = false;
      }

      if (key === "autoLiveEnabled" && !nextValue) {
        nextState.liveTrading = false;
        nextState.paused = false;
      }

      return {
        ...nextState,
        lastAction: `${READINESS_FIELDS.find((field) => field.key === key)?.label ?? "Readiness"} switched ${nextValue ? "on" : "off"}.`,
      };
    });
  }

  function handleStartBot() {
    const timeline = createTimelineSnapshot();
    setLastAction("Auto-Live bot started. The engine is armed and waiting on the next cycle.", {
      autoLiveEnabled: true,
      paused: false,
      liveTrading: false,
      nextScan: timeline.nextScan,
      nextLlmRun: timeline.nextLlmRun,
      nextRebalance: timeline.nextRebalance,
    });
  }

  function handleStopBot() {
    setLastAction("Auto-Live bot stopped. Scans and live rebalances are now idle.", {
      autoLiveEnabled: false,
      liveTrading: false,
      paused: false,
      nextScan: null,
      nextLlmRun: null,
      nextRebalance: null,
    });
  }

  function handlePause() {
    setLastAction("Auto-Live paused. Existing positions remain visible while new candidate scans are held.", {
      paused: true,
      liveTrading: false,
    });
  }

  function handleResume() {
    const resumeMessage =
      canRunLiveRebalance && !controlState.dryRun
        ? "Auto-Live resumed and re-armed for the next live rebalance window."
        : "Auto-Live resumed, but live execution is still gated by the current readiness checks.";

    setLastAction(resumeMessage, {
      paused: false,
      liveTrading: canRunLiveRebalance && !controlState.dryRun,
    });
  }

  function handleRunDryRun() {
    const timeline = createTimelineSnapshot();
    setLastAction(
      "Dry-run cycle completed. Scan, evidence, and consensus were refreshed without routing live orders.",
      {
        autoLiveEnabled: true,
        dryRun: true,
        liveTrading: false,
        paused: false,
        lastScan: timeline.lastScan,
        lastLlmRun: timeline.lastLlmRun,
        nextScan: timeline.nextScan,
        nextLlmRun: timeline.nextLlmRun,
      },
    );
  }

  function handleRunLiveRebalance() {
    if (!canRunLiveRebalance) return;
    const timeline = createTimelineSnapshot();

    setLastAction(
      "Live rebalance submitted. Limit orders are staged against target exposure deltas.",
      {
        autoLiveEnabled: true,
        dryRun: false,
        paused: false,
        liveTrading: true,
        lastScan: timeline.lastScan,
        lastLlmRun: timeline.lastLlmRun,
        lastRebalance: new Date().toISOString(),
        nextScan: timeline.nextScan,
        nextLlmRun: timeline.nextLlmRun,
        nextRebalance: timeline.nextRebalance,
      },
    );
  }

  function handleEmergencyStop() {
    setLastAction(
      "Emergency stop activated. All live order submission is blocked until the stop is cleared.",
      {
        emergencyStop: true,
        liveTrading: false,
        paused: false,
      },
    );
  }

  function toggleExpanded(rowId: string) {
    setExpandedRows((current) => ({
      ...current,
      [rowId]: !current[rowId],
    }));
  }

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 pb-8">
      <div className="space-y-3">
        <div className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Trading Bots
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">
            Bullpen AI Auto-Live
          </h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
            Automated Bullpen trading using market rules, shared evidence, LLM
            consensus, portfolio guardrails, and live limit-order execution.
          </p>
        </div>
      </div>

      <Card className="gap-0 rounded-[28px] border border-slate-200 bg-white py-0 shadow-sm">
        <CardHeader className="gap-4 border-b border-slate-100 px-6 py-6 sm:px-7">
          <div className="flex flex-wrap items-center gap-2">
            {modeBadges.map((badge) => (
              <span
                key={badge.label}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  badge.active
                    ? badge.activeClass
                    : "border-slate-200 bg-white text-slate-400",
                )}
              >
                {badge.label}
              </span>
            ))}
          </div>
          <div>
            <CardTitle className="text-base tracking-[0.18em] text-slate-950">
              Automation Console
            </CardTitle>
            <CardDescription className="mt-2 max-w-5xl text-sm text-slate-600">
              Auto-Live sits beside Bullpen x AI rather than replacing it. The
              manual page stays focused on analysis and odds work, while this
              console owns scanning, guardrails, rebalancing, and live execution
              controls.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
              onClick={handleStartBot}
              disabled={
                controlState.autoLiveEnabled &&
                !controlState.paused &&
                !controlState.liveTrading
              }
            >
              Start Bot
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
              onClick={handleStopBot}
              disabled={
                !controlState.autoLiveEnabled &&
                !controlState.liveTrading &&
                !controlState.paused
              }
            >
              Stop Bot
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
              onClick={handlePause}
              disabled={!controlState.autoLiveEnabled || controlState.paused}
            >
              Pause
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
              onClick={handleResume}
              disabled={!controlState.paused || !controlState.autoLiveEnabled}
            >
              Resume
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
              onClick={handleRunDryRun}
            >
              Run Dry-Run Now
            </Button>
            <Button
              size="sm"
              className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500"
              onClick={handleRunLiveRebalance}
              disabled={!canRunLiveRebalance}
            >
              Run Live Rebalance Now
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="rounded-full px-5"
              onClick={handleEmergencyStop}
              disabled={controlState.emergencyStop}
            >
              Emergency Stop
            </Button>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
            >
              <a href="#risk-guardrails">Risk Guardrails</a>
            </Button>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
            >
              <a href="#seven-stage-flow">View 7-Stage Flow</a>
            </Button>
          </div>
          <div
            className={cn(
              "rounded-2xl border px-4 py-3 text-sm leading-6",
              canRunLiveRebalance
                ? "border-emerald-200 bg-emerald-50/80 text-emerald-900"
                : "border-amber-200 bg-amber-50/80 text-amber-900",
            )}
          >
            {canRunLiveRebalance
              ? "Run Live Rebalance Now is unlocked. Every required execution gate is currently green."
              : `Run Live Rebalance Now stays disabled until ${liveBlockers.join(
                  ", ",
                )}.`}
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 px-6 py-6 sm:px-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.95fr)]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Live state
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {controlState.lastAction}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Operator handoff
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  asChild
                  size="sm"
                  className="rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
                >
                  <Link href={URLs.routes.console.tradingBots()}>
                    Open Trading Bots Overview
                  </Link>
                </Button>
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="rounded-full border-slate-300 px-5"
                >
                  <Link href={URLs.routes.console.bullpenAi()}>
                    Open Bullpen x AI
                  </Link>
                </Button>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Bullpen x AI remains the manual analysis surface. Auto-Live
                focuses on scans, guardrails, and live execution state.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Execution readiness
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {READINESS_FIELDS.map((field) => {
                const isEnabled = controlState[field.key];
                return (
                  <button
                    key={field.key}
                    type="button"
                    onClick={() => toggleReadiness(field.key)}
                    className={cn(
                      "rounded-2xl border px-4 py-3 text-left shadow-sm transition",
                      isEnabled
                        ? "border-slate-300 bg-slate-50 hover:border-sky-300 hover:bg-sky-50"
                        : "border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        {field.label}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                          isEnabled
                            ? field.key === "emergencyStop"
                              ? "border-rose-200 bg-rose-50 text-rose-700"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 bg-white text-slate-500",
                        )}
                      >
                        {isEnabled ? (field.key === "emergencyStop" ? "Active" : "On") : "Off"}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-700">
                      {field.helper}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metricItems.map((item) => (
          <div
            key={item.label}
            className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-3 shadow-sm"
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {item.label}
            </div>
            <div
              className={cn(
                "mt-2 text-sm font-semibold",
                item.tone === "positive"
                  ? "text-emerald-700"
                  : item.tone === "negative"
                    ? "text-rose-700"
                    : "text-slate-950",
              )}
            >
              {item.value}
            </div>
            <div className="mt-1 text-xs leading-5 text-slate-500">
              {item.helper}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <Card
          id="risk-guardrails"
          className="rounded-[28px] border border-slate-200 bg-white shadow-sm"
        >
          <CardHeader>
            <CardTitle className="text-base tracking-[0.18em] text-slate-950">
              Risk Guardrails
            </CardTitle>
            <CardDescription className="text-sm text-slate-600">
              Live orders only unlock when capital, evidence, and execution
              guardrails all remain in-policy.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {guardrailItems.map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    {item.label}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                      getStatusClass(item.status),
                    )}
                  >
                    {item.status}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  {item.value}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card
          id="seven-stage-flow"
          className="rounded-[28px] border border-slate-200 bg-white shadow-sm"
        >
          <CardHeader>
            <CardTitle className="text-base tracking-[0.18em] text-slate-950">
              7-Stage Flow
            </CardTitle>
            <CardDescription className="text-sm text-slate-600">
              Every market runs through the same audit chain before it can reach
              live limit-order execution.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {AUTO_LIVE_STAGE_FLOW.map((stage, index) => (
              <div
                key={stage.label}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Stage {index + 1}
                </p>
                <p className="mt-2 text-sm font-semibold text-slate-950">
                  {stage.label}
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  {stage.description}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Live Positions And Candidates
              </CardTitle>
              <CardDescription className="mt-2 text-sm text-slate-600">
                Active positions and new candidates share one board so the
                rebalance engine can compare current exposure versus target
                exposure in a single place.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                {formatNumber(activeRows.length)} active positions
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                {formatNumber(candidateRows.length)} new candidates
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {emptyStates.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {emptyStates.map((state) => (
                <div
                  key={state.title}
                  className={cn(
                    "rounded-2xl border px-4 py-4",
                    getToneClass(state.tone),
                  )}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                    {state.title}
                  </p>
                  <p className="mt-2 text-sm leading-6">{state.description}</p>
                </div>
              ))}
            </div>
          ) : null}

          {displayRows.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-12 text-center">
              <p className="text-sm font-semibold text-slate-900">
                Bot not configured
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Turn Auto-Live back on to repopulate the combined positions and
                candidates board.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-[24px] border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50/90 text-left">
                  <tr className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <th className="px-4 py-3">Market</th>
                    <th className="px-4 py-3">Category/theme</th>
                    <th className="px-4 py-3">Side</th>
                    <th className="px-4 py-3">Current price</th>
                    <th className="px-4 py-3">LLM fair probability</th>
                    <th className="px-4 py-3">Edge</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Current exposure</th>
                    <th className="px-4 py-3">Target exposure</th>
                    <th className="px-4 py-3">Proposed order</th>
                    <th className="px-4 py-3">Decision</th>
                    <th className="px-4 py-3">Risk status</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Last updated</th>
                  </tr>
                </thead>
                {displayRows.map((row) => {
                  const isExpanded = Boolean(expandedRows[row.id]);
                  return (
                    <tbody
                      key={row.id}
                      className="divide-y divide-slate-200 bg-white"
                    >
                      <tr className="align-top text-sm text-slate-700">
                        <td className="px-4 py-4">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(row.id)}
                            className="flex items-start gap-3 text-left"
                          >
                            {isExpanded ? (
                              <ChevronDown className="mt-0.5 size-4 text-slate-400" />
                            ) : (
                              <ChevronRight className="mt-0.5 size-4 text-slate-400" />
                            )}
                            <div>
                              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                                {row.kind === "active" ? "Active position" : "New candidate"}
                              </span>
                              <p className="mt-2 font-semibold text-slate-950">
                                {row.market}
                              </p>
                            </div>
                          </button>
                        </td>
                        <td className="px-4 py-4">{row.category}</td>
                        <td className="px-4 py-4">
                          <span
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                              row.side === "YES"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-rose-200 bg-rose-50 text-rose-700",
                            )}
                          >
                            {row.side}
                          </span>
                        </td>
                        <td className="px-4 py-4">{formatPercent(row.currentPrice)}</td>
                        <td className="px-4 py-4">
                          {formatPercent(row.fairProbability)}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-4 font-semibold",
                            row.edge >= 0 ? "text-emerald-700" : "text-rose-700",
                          )}
                        >
                          {row.edge >= 0 ? "+" : ""}
                          {formatPercent(row.edge)}
                        </td>
                        <td className="px-4 py-4">{row.score}</td>
                        <td className="px-4 py-4">
                          {formatMoney(row.currentExposure)}
                        </td>
                        <td className="px-4 py-4">
                          {formatMoney(row.targetExposure)}
                        </td>
                        <td className="px-4 py-4">{row.proposedOrder}</td>
                        <td className="px-4 py-4">
                          <span
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                              getDecisionClass(row.decision),
                            )}
                          >
                            {row.decision}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                              getRiskStatusClass(row.riskStatus),
                            )}
                          >
                            {row.riskStatus}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-slate-600">{row.reason}</td>
                        <td className="px-4 py-4 whitespace-nowrap text-slate-500">
                          {formatDateTime(row.lastUpdated)}
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr>
                          <td colSpan={14} className="bg-slate-50/60 px-4 py-4">
                            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                              <div className="space-y-4">
                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    7-stage audit trail
                                  </p>
                                  <div className="mt-3 space-y-3">
                                    {row.stageAudit.map((entry) => (
                                      <div
                                        key={`${row.id}-${entry.label}`}
                                        className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3"
                                      >
                                        <div className="flex items-center justify-between gap-3">
                                          <p className="text-sm font-semibold text-slate-950">
                                            {entry.label}
                                          </p>
                                          <span
                                            className={cn(
                                              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                                              getStatusClass(entry.status),
                                            )}
                                          >
                                            {entry.status}
                                          </span>
                                        </div>
                                        <p className="mt-2 text-sm leading-6 text-slate-600">
                                          {entry.detail}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    Evidence summary
                                  </p>
                                  <div className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
                                    {row.evidenceSummary.map((item) => (
                                      <p key={item}>{item}</p>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <div className="space-y-4">
                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    Guardrails checked
                                  </p>
                                  <div className="mt-3 space-y-3">
                                    {row.guardrailsChecked.map((item) => (
                                      <div key={`${row.id}-${item.label}`}>
                                        <div className="flex items-center justify-between gap-3">
                                          <p className="text-sm font-semibold text-slate-950">
                                            {item.label}
                                          </p>
                                          <span
                                            className={cn(
                                              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                                              getStatusClass(item.status),
                                            )}
                                          >
                                            {item.status}
                                          </span>
                                        </div>
                                        <p className="mt-1 text-sm leading-6 text-slate-600">
                                          {item.detail}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    LLM consensus stats
                                  </p>
                                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                        Models
                                      </p>
                                      <p className="mt-2 text-sm font-semibold text-slate-950">
                                        {row.llmConsensus.models}
                                      </p>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                        Agreement
                                      </p>
                                      <p className="mt-2 text-sm font-semibold text-slate-950">
                                        {formatPercent(row.llmConsensus.agreementPct)}
                                      </p>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                        Median fair prob
                                      </p>
                                      <p className="mt-2 text-sm font-semibold text-slate-950">
                                        {formatPercent(row.llmConsensus.medianProbability)}
                                      </p>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                        Spread
                                      </p>
                                      <p className="mt-2 text-sm font-semibold text-slate-950">
                                        {formatPercent(row.llmConsensus.spread)}
                                      </p>
                                    </div>
                                  </div>
                                  <p className="mt-3 text-sm leading-6 text-slate-600">
                                    {row.llmConsensus.dissentSummary}
                                  </p>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    Sizing calculation
                                  </p>
                                  <div className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
                                    <p>
                                      <span className="font-semibold text-slate-950">
                                        Stake:
                                      </span>{" "}
                                      {formatMoney(row.sizing.stakeUsd)}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-slate-950">
                                        Bankroll share:
                                      </span>{" "}
                                      {formatPercent(row.sizing.bankrollPct)}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-slate-950">
                                        Max loss:
                                      </span>{" "}
                                      {formatMoney(row.sizing.maxLossUsd)}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-slate-950">
                                        Reserve after trade:
                                      </span>{" "}
                                      {formatMoney(row.sizing.reserveAfterTradeUsd)}
                                    </p>
                                    <p>{row.sizing.explanation}</p>
                                  </div>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    Execution / pre-trade status
                                  </p>
                                  <div className="mt-3 space-y-3">
                                    {row.executionChecks.map((item) => (
                                      <div key={`${row.id}-${item.label}`}>
                                        <div className="flex items-center justify-between gap-3">
                                          <p className="text-sm font-semibold text-slate-950">
                                            {item.label}
                                          </p>
                                          <span
                                            className={cn(
                                              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                                              getStatusClass(item.status),
                                            )}
                                          >
                                            {item.status}
                                          </span>
                                        </div>
                                        <p className="mt-1 text-sm leading-6 text-slate-600">
                                          {item.detail}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
