"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

import { apiService } from "@/services/api";
import type { Bullpen008StageOutput } from "@/types/api";

const TILE_ENHANCED_ATTR = "data-bullpen008-metric-drilldown";

const STAGE_METRIC_KEYS: Record<number, string[]> = {
  1: [
    "high_shock_rejected",
    "less_than_48_hour_rejected",
    "existing_high_shock_monitored",
    "timing_unresolved",
    "scanned",
    "accepted",
  ],
  2: [
    "evidence_complete",
    "evidence_stale",
    "conservative_edge_rejected",
    "high_disagreement_rejected",
    "reward_skew_rejected",
    "analysed",
  ],
  3: [
    "joint_loss_scenarios",
    "high_shock_scenarios",
    "unresolved_scenarios",
    "largest_current_scenario_loss",
    "strict_clusters",
    "common_catalyst_clusters",
  ],
  4: [
    "maximum_scenario_loss",
    "binding_risk_tier",
    "contingent_exits_certified",
    "mandatory_time_exits",
    "scenario_cap_result",
    "invested",
  ],
  5: [
    "dormant_contingent_exits",
    "activated_reductions",
    "drawdown_mode",
    "exit_only_status",
    "plan_certificate_result",
    "claims",
    "cancellations",
    "sells",
    "trims",
    "buys",
    "holds",
    "blocked",
  ],
  6: [
    "planned",
    "risk_certified",
    "would_submit",
    "ready",
    "durable_intents",
    "submitted",
    "confirmed",
    "partially_filled",
    "blocked",
    "failed",
    "recoverable",
    "reconciled",
  ],
};

type Row = Record<string, unknown>;

type DrilldownState = {
  stageNumber: number;
  metricKey: string;
  metricLabel: string;
  metricValue: string;
  stage: Bullpen008StageOutput | null;
  loading: boolean;
  error: string | null;
};

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,%]/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function arrayContains(row: Row, key: string, expected: string) {
  return Array.isArray(row[key]) && (row[key] as unknown[]).some((value) => text(value) === expected);
}

function genericArrays(outputs: Row): Row[] {
  return Object.entries(outputs).flatMap(([source, value]) =>
    asRows(value).map((row): Row => ({ ...row, _breakdown_source: source })),
  );
}

function uniqueBy(rows: Row[], keyFn: (row: Row) => string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = keyFn(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clusterRows(rows: Row[], field: "strict_cluster_id" | "common_catalyst_cluster_id") {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const id = text(row[field]);
    if (!id) continue;
    const members = grouped.get(id) ?? [];
    members.push(row);
    grouped.set(id, members);
  }
  return Array.from(grouped.entries()).map(([id, members]) => ({
    ...members[0],
    question: text(members[0].question) || id,
    breakdown_group: id,
    member_count: members.length,
    detail: `${members.length} market${members.length === 1 ? "" : "s"} in ${id}`,
  }));
}

function scenarioLoss(row: Row) {
  const explicit = [
    row.gross_loss_usd,
    row.maximum_loss_usd,
    row.loss_at_risk_usd,
    row.scenario_loss_usd,
    row.existing_loss_at_risk_usd,
  ].map(numberValue).find((value) => value !== null);
  if (explicit !== null && explicit !== undefined) {
    return explicit + (numberValue(row.pending_loss_at_risk_usd) ?? 0);
  }
  return 0;
}

function decorateScenario(row: Row): Row {
  const affected = Array.isArray(row.affected_markets)
    ? row.affected_markets
    : Array.isArray(row.market_ids)
      ? row.market_ids
      : [];
  return {
    ...row,
    question: text(row.description) || text(row.driver) || text(row.scenario_id) || "Joint-loss scenario",
    category: text(row.risk_tier) || "Joint-loss scenario",
    outcomes: affected.length ? [`${affected.length} affected markets`] : row.outcomes,
    detail:
      text(row.scenario_id) ||
      text(row.trigger) ||
      text(row.main_joint_loss_trigger) ||
      `${scenarioLoss(row).toFixed(2)} USD loss at risk`,
  };
}

function stage1Rows(outputs: Row, metricKey: string) {
  const rows = asRows(outputs.rows);
  if (metricKey === "high_shock_rejected") return rows.filter((row) => arrayContains(row, "risk_rejection_codes", "SINGLE_DAY_HIGH_SHOCK"));
  if (metricKey === "less_than_48_hour_rejected") return rows.filter((row) => arrayContains(row, "risk_rejection_codes", "HIGH_SHOCK_ENTRY_WINDOW_LT_48H"));
  if (metricKey === "existing_high_shock_monitored") return rows.filter((row) => Boolean(row.active_position) && text(row.risk_tier) !== "standard_objective");
  if (metricKey === "timing_unresolved") return rows.filter((row) => arrayContains(row, "risk_rejection_codes", "HIGH_SHOCK_TIMING_UNRESOLVED"));
  if (metricKey === "accepted") return rows.filter((row) => ["accepted", "accepted_monitoring"].includes(text(row.accounting_status)));
  return rows;
}

function stage2Rows(outputs: Row, metricKey: string) {
  const rows = asRows(outputs.rows);
  if (metricKey === "evidence_complete") return rows.filter((row) => Boolean(asRecord(row.evidence_validation).evidence_complete));
  if (metricKey === "evidence_stale") return rows.filter((row) => arrayContains(row, "entry_rejection_codes", "EVIDENCE_STALE"));
  if (metricKey === "conservative_edge_rejected") return rows.filter((row) => arrayContains(row, "entry_rejection_codes", "CONSERVATIVE_EDGE_BELOW_MINIMUM"));
  if (metricKey === "high_disagreement_rejected") return rows.filter((row) => arrayContains(row, "entry_rejection_codes", "MODEL_DISAGREEMENT_HIGH") || text(row.llm_disagreement_level).toLowerCase() === "high");
  if (metricKey === "reward_skew_rejected") return rows.filter((row) => arrayContains(row, "entry_rejection_codes", "REWARD_TO_LOSS_BELOW_MINIMUM"));
  return rows;
}

function stage3Rows(outputs: Row, metricKey: string) {
  const rows = asRows(outputs.rows);
  const scenarios = asRows(outputs.joint_loss_scenarios).map(decorateScenario);
  if (metricKey === "joint_loss_scenarios") return scenarios;
  if (metricKey === "high_shock_scenarios") return scenarios.filter((row) => text(row.risk_tier) !== "standard_objective");
  if (metricKey === "unresolved_scenarios") {
    const unresolved = asRows(outputs.unresolved_adjudications);
    return unresolved.length ? unresolved : scenarios.filter((row) => Boolean(row.unresolved) || text(row.status).toLowerCase().includes("unresolved"));
  }
  if (metricKey === "largest_current_scenario_loss") {
    const maxLoss = Math.max(0, ...scenarios.map(scenarioLoss));
    return scenarios.filter((row) => Math.abs(scenarioLoss(row) - maxLoss) < 0.001);
  }
  if (metricKey === "strict_clusters") return clusterRows(rows, "strict_cluster_id");
  if (metricKey === "common_catalyst_clusters") return clusterRows(rows, "common_catalyst_cluster_id");
  return rows;
}

function stage4Rows(outputs: Row, metricKey: string, metricValue: string) {
  const allocations = asRows(outputs.allocations);
  const scenarios = [
    ...asRows(outputs.joint_scenario_stress),
    ...asRows(outputs.scenario_stress),
    ...asRows(outputs.scenario_cap_results),
  ].map(decorateScenario);
  const policies = asRows(outputs.contingent_exit_policies);
  if (metricKey === "maximum_scenario_loss") {
    const maxLoss = Math.max(0, ...scenarios.map(scenarioLoss));
    return scenarios.filter((row) => Math.abs(scenarioLoss(row) - maxLoss) < 0.001);
  }
  if (metricKey === "binding_risk_tier") {
    const normalized = metricValue.toLowerCase().replaceAll(" ", "_");
    return allocations.filter((row) => text(row.risk_tier).toLowerCase() === normalized);
  }
  if (metricKey === "contingent_exits_certified") return policies;
  if (metricKey === "mandatory_time_exits") return policies.filter((row) => Boolean(row.mandatory_time_exit) || row.time_exit_at || row.exit_deadline || row.time_exit_hours);
  if (metricKey === "scenario_cap_result") return scenarios.length ? scenarios : allocations;
  if (metricKey === "invested") return allocations.filter((row) => (numberValue(row.target_exposure_usd) ?? numberValue(row.proposed_buy_usd) ?? 0) > 0);
  return allocations;
}

function stage5Rows(outputs: Row, metricKey: string) {
  const direct: Record<string, string[]> = {
    dormant_contingent_exits: ["dormant_contingent_exits"],
    activated_reductions: ["activated_reductions", "full_exits", "trims"],
    claims: ["claims"],
    cancellations: ["order_cancellations", "cancellations"],
    sells: ["full_exits", "sells"],
    trims: ["trims"],
    buys: ["buys"],
    holds: ["holds"],
    blocked: ["blocked_untradeable", "blocked"],
  };
  const names = direct[metricKey];
  if (names) return names.flatMap((name) => asRows(outputs[name]));
  return genericArrays(outputs).filter((row) => {
    const source = text(row._breakdown_source).toLowerCase();
    const status = text(row.status).toLowerCase();
    if (metricKey === "drawdown_mode") return source.includes("drawdown") || Boolean(row.drawdown_mode) || Boolean(row.drawdown_state);
    if (metricKey === "exit_only_status") return Boolean(row.exit_only) || source.includes("exit_only");
    if (metricKey === "plan_certificate_result") return source.includes("certificate") || status.includes("certif");
    return false;
  });
}

function stage6Rows(outputs: Row, metricKey: string) {
  const rows = uniqueBy(genericArrays(outputs), (row) => text(row.intent_id) || text(row.action_id) || `${text(row.market_id)}:${text(row.status)}:${text(row._breakdown_source)}`);
  if (metricKey === "planned") return rows.filter((row) => Boolean(row.action_id) || text(row._breakdown_source).includes("plan"));
  if (metricKey === "risk_certified") return rows.filter((row) => row.risk_certified === true || row.certified === true || text(row.status).toLowerCase().includes("certif"));
  if (metricKey === "would_submit") return rows.filter((row) => row.would_submit === true || text(row.status).toUpperCase() === "WOULD_SUBMIT");
  if (metricKey === "ready") return rows.filter((row) => row.ready === true || text(row.status).toLowerCase() === "ready");
  if (metricKey === "durable_intents") return rows.filter((row) => Boolean(row.intent_id));
  const statusMap: Record<string, string[]> = {
    submitted: ["submitted"],
    confirmed: ["confirmed", "filled"],
    partially_filled: ["partially_filled", "partial"],
    blocked: ["blocked"],
    failed: ["failed", "error"],
    recoverable: ["recoverable", "retryable"],
    reconciled: ["reconciled"],
  };
  const accepted = statusMap[metricKey];
  if (!accepted) return rows;
  return rows.filter((row) => accepted.some((status) => text(row.status).toLowerCase().includes(status) || text(row.execution_status).toLowerCase().includes(status)));
}

function breakdownRows(stage: Bullpen008StageOutput, metricKey: string, metricValue: string) {
  const outputs = asRecord(stage.outputs);
  let rows: Row[] = [];
  if (stage.stage_number === 1) rows = stage1Rows(outputs, metricKey);
  else if (stage.stage_number === 2) rows = stage2Rows(outputs, metricKey);
  else if (stage.stage_number === 3) rows = stage3Rows(outputs, metricKey);
  else if (stage.stage_number === 4) rows = stage4Rows(outputs, metricKey, metricValue);
  else if (stage.stage_number === 5) rows = stage5Rows(outputs, metricKey);
  else if (stage.stage_number === 6) rows = stage6Rows(outputs, metricKey);

  if (rows.length) return rows;

  const fallback = genericArrays(outputs);
  if (fallback.length) return fallback;
  return asRows(outputs.rows);
}

function formatDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "—";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatPercent(value: unknown) {
  const numeric = numberValue(value);
  return numeric === null ? "—" : `${numeric.toFixed(2)}%`;
}

function formatDays(row: Row) {
  const days = numberValue(row.days_until_close ?? row.days_left);
  if (days !== null) return `${days.toFixed(1)}d`;
  const hours = numberValue(row.hours_remaining);
  return hours === null ? "—" : `${(hours / 24).toFixed(1)}d`;
}

function currentOdds(row: Row) {
  const yes = numberValue(row.current_yes_odds);
  const no = numberValue(row.current_no_odds);
  if (yes !== null || no !== null) {
    return `Yes: ${yes === null ? "—" : `${yes.toFixed(2)}%`} · No: ${no === null ? "—" : `${no.toFixed(2)}%`}`;
  }
  return formatPercent(row.current_odds ?? row.current_chosen_side_bullpen_odds ?? row.quoted_price_cents);
}

function llmOdds(row: Row) {
  const yes = numberValue(row.llm_yes_probability ?? row.llm_yes_odds);
  const no = numberValue(row.llm_no_probability ?? row.llm_no_odds);
  if (yes !== null || no !== null) {
    return `Yes: ${yes === null ? "—" : `${yes.toFixed(2)}%`} · No: ${no === null ? "—" : `${no.toFixed(2)}%`}`;
  }
  return formatPercent(row.chosen_side_llm_probability ?? row.llm_odds);
}

function eventLabel(row: Row) {
  return text(row.question) || text(row.market_title) || text(row.description) || text(row.driver) || text(row.market_id) || text(row.action_id) || "Unknown event";
}

function detailLabel(row: Row) {
  const reasons = Array.isArray(row.rejection_reasons)
    ? row.rejection_reasons.map((reason) => text(asRecord(reason).reason || asRecord(reason).code)).filter(Boolean).join("; ")
    : "";
  return (
    text(row.detail) ||
    text(row.reason_code) ||
    text(row.reason) ||
    reasons ||
    text(row.status) ||
    text(row.accounting_status) ||
    text(row.breakdown_group) ||
    text(row._breakdown_source) ||
    "—"
  );
}

export function Bullpen008MetricTileDrilldownEnhancer() {
  const [state, setState] = useState<DrilldownState | null>(null);

  const openDrilldown = useCallback(async (stageNumber: number, metricKey: string, metricLabel: string, metricValue: string) => {
    setState({ stageNumber, metricKey, metricLabel, metricValue, stage: null, loading: true, error: null });
    try {
      const bootstrap = await apiService.getBullpen008Bootstrap();
      const runId = bootstrap.latest_run?.id;
      if (!runId) throw new Error("No Bullpen 008 run is available yet.");
      const stage = await apiService.getBullpen008Stage(runId, stageNumber);
      setState({ stageNumber, metricKey, metricLabel, metricValue, stage, loading: false, error: null });
    } catch (error) {
      setState({
        stageNumber,
        metricKey,
        metricLabel,
        metricValue,
        stage: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    const enhance = () => {
      const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Stage "]'));
      for (const card of cards) {
        const match = card.getAttribute("aria-label")?.match(/^Stage\s+([1-6]):/i);
        const stageNumber = match ? Number(match[1]) : 0;
        const metricKeys = STAGE_METRIC_KEYS[stageNumber];
        if (!metricKeys) continue;
        const grid = Array.from(card.querySelectorAll<HTMLElement>("div")).find((element) =>
          element.classList.contains("grid") && element.classList.contains("grid-cols-2") && element.children.length === metricKeys.length,
        );
        if (!grid) continue;
        Array.from(grid.children).forEach((child, index) => {
          const tile = child as HTMLElement;
          if (tile.getAttribute(TILE_ENHANCED_ATTR) === "true") return;
          const metricKey = metricKeys[index];
          if (!metricKey) return;
          const paragraphs = tile.querySelectorAll("p");
          const metricLabel = paragraphs[0]?.textContent?.trim() || metricKey.replaceAll("_", " ");
          const metricValue = paragraphs[1]?.textContent?.trim() || "—";
          tile.setAttribute(TILE_ENHANCED_ATTR, "true");
          tile.setAttribute("role", "button");
          tile.setAttribute("tabindex", "0");
          tile.setAttribute("aria-label", `Open ${metricLabel} breakdown`);
          tile.title = `Open ${metricLabel} breakup list`;
          tile.style.cursor = "pointer";
          tile.style.transition = "border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease";
          const activate = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void openDrilldown(stageNumber, metricKey, metricLabel, metricValue);
          };
          const keyActivate = (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            activate(event);
          };
          tile.addEventListener("click", activate);
          tile.addEventListener("keydown", keyActivate);
          tile.addEventListener("mouseenter", () => {
            tile.style.borderColor = "rgb(56 189 248)";
            tile.style.backgroundColor = "rgb(240 249 255)";
            tile.style.boxShadow = "0 1px 3px rgb(14 165 233 / 0.12)";
          });
          tile.addEventListener("mouseleave", () => {
            tile.style.borderColor = "";
            tile.style.backgroundColor = "";
            tile.style.boxShadow = "";
          });
          cleanups.push(() => {
            tile.removeEventListener("click", activate);
            tile.removeEventListener("keydown", keyActivate);
          });
        });
      }
    };

    enhance();
    const observer = new MutationObserver(enhance);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const cleanup of cleanups) cleanup();
    };
  }, [openDrilldown]);

  const rows = useMemo(() => {
    if (!state?.stage) return [];
    return breakdownRows(state.stage, state.metricKey, state.metricValue);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  if (!state) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 p-4" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) setState(null);
    }}>
      <section role="dialog" aria-modal="true" aria-label={`Stage ${state.stageNumber} ${state.metricLabel} breakdown`} className="flex max-h-[92vh] w-[min(1600px,96vw)] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Bullpen 008 · Stage {state.stageNumber} sub-stage breakup</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">{state.metricLabel}</h2>
            <p className="mt-1 text-sm text-slate-600">Tile value: <strong className="text-slate-900">{state.metricValue}</strong>. This popup shows the underlying events, clusters, scenarios or actions that make up that tile.</p>
          </div>
          <button type="button" aria-label="Close metric breakdown" className="rounded-full border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-900" onClick={() => setState(null)}>
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {state.loading ? (
            <div className="flex min-h-72 items-center justify-center gap-3 text-sm text-slate-600"><Loader2 className="h-5 w-5 animate-spin" /> Loading immutable Stage {state.stageNumber} record…</div>
          ) : state.error ? (
            <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><strong>Could not load breakup.</strong> {state.error}</div></div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="min-w-[1180px] w-full text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-12 px-4 py-3 text-center">#</th>
                    <th className="min-w-[320px] px-4 py-3">Event / group</th>
                    <th className="min-w-[180px] px-4 py-3">Closing time</th>
                    <th className="px-4 py-3">Days left</th>
                    <th className="min-w-[160px] px-4 py-3">Category</th>
                    <th className="min-w-[140px] px-4 py-3">Outcomes</th>
                    <th className="min-w-[180px] px-4 py-3">Current Odds</th>
                    <th className="min-w-[180px] px-4 py-3">LLM Odds</th>
                    <th className="px-4 py-3 text-right">Returns/day</th>
                    <th className="min-w-[260px] px-4 py-3">Why in this tile</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rows.map((row, index) => (
                    <tr key={`${text(row.market_id) || text(row.action_id) || text(row.scenario_id) || index}-${index}`} className="align-top hover:bg-sky-50/40">
                      <td className="px-4 py-3 text-center font-semibold text-slate-500">{index + 1}</td>
                      <td className="px-4 py-3 font-medium text-slate-950"><div className="max-w-lg whitespace-normal">{eventLabel(row)}</div><div className="mt-1 font-mono text-[11px] text-slate-400">{text(row.market_id) || text(row.scenario_id) || text(row.action_id)}</div></td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(row.deadline ?? row.close_time ?? row.closing_time)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDays(row)}</td>
                      <td className="px-4 py-3 text-slate-600">{text(row.category) || text(row.theme) || text(row.risk_tier) || text(row.action_type) || "—"}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{Array.isArray(row.outcomes) ? row.outcomes.map(text).filter(Boolean).join(" / ") : text(row.side ?? row.chosen_side) || "—"}</td>
                      <td className="px-4 py-3 tabular-nums text-slate-700">{currentOdds(row)}</td>
                      <td className="px-4 py-3 tabular-nums text-slate-700">{llmOdds(row)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums font-semibold text-slate-700">{numberValue(row.returns_per_day) === null ? "—" : `${numberValue(row.returns_per_day)?.toFixed(2)}%`}</td>
                      <td className="px-4 py-3 text-slate-600"><div className="max-w-sm whitespace-normal">{detailLabel(row)}</div></td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr><td colSpan={10} className="px-4 py-12 text-center text-slate-500">This tile currently has no underlying records. The zero/empty result is shown explicitly rather than opening the full-stage popup.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {!state.loading && !state.error ? (
          <footer className="border-t border-slate-200 bg-slate-50 px-6 py-3 text-xs text-slate-600">Breakup rows shown: <strong>{rows.length}</strong> · Source: immutable Stage {state.stageNumber} output from the latest Bullpen 008 run.</footer>
        ) : null}
      </section>
    </div>
  );
}
