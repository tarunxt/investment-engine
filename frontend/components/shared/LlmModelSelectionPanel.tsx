"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

import {
  countSelectedWebCapableModels,
  getInternetAccessBadgeText,
  getInternetAccessTooltipText,
  getResolvedProviderInternetAccess,
} from "@/lib/llmInternetAccess";
import { cn } from "@/lib/utils";
import type { ProviderInfo } from "@/types/api";

interface LlmModelSelectionPanelProps {
  providers: ProviderInfo[];
  selectedKeys: Set<string>;
  selectionMode?: "single" | "multiple";
  title?: string;
  emptyMessage?: string;
  loading?: boolean;
  loadingRows?: number;
  modelMixControls?: ReactNode;
  showBulkActions?: boolean;
  onToggle: (key: string) => void;
  selectedMultipliers?: Record<string, number>;
  onMultiplierChange?: (key: string, nextValue: number) => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  onSelectWebCapable?: () => void;
  onToggleProvider?: (providerName: string, models: string[]) => void;
  getSelectionConstraint?: (
    provider: ProviderInfo,
    model: string,
  ) => {
    selectable: boolean;
    reason?: string | null;
  } | null | undefined;
  getEstimatedCostInr?: (
    providerName: string,
    model: string,
  ) => number | undefined;
  getHistoricalCostInr?: (
    providerName: string,
    model: string,
  ) => number | undefined;
  costSummaryLabel?: string;
  costSummaryValue?: string;
  historicalCostSummaryLabel?: string;
}

type ProviderCostSummary = {
  selectedCount: number;
  estimatedCostInr: number;
  historicalCostInr: number;
};

function getModelKey(providerName: string, model: string) {
  return `${providerName}::${model}`;
}

function isCompatible(provider: ProviderInfo, model: string) {
  return (
    provider.configured &&
    provider.model_compatibility?.[model]?.compatible !== false
  );
}

function getCompatibilityReason(
  provider: ProviderInfo,
  model: string,
  getSelectionConstraint?: (
    provider: ProviderInfo,
    model: string,
  ) => {
    selectable: boolean;
    reason?: string | null;
  } | null | undefined,
) {
  if (!provider.configured) return "Provider is not configured.";
  const selectionConstraint = getSelectionConstraint?.(provider, model);
  if (selectionConstraint?.selectable === false) {
    return selectionConstraint.reason || "Currently unavailable.";
  }
  return (
    provider.model_compatibility?.[model]?.reason || "Currently unavailable."
  );
}

function formatInrCost(cost: number) {
  return `₹${cost.toFixed(2)}`;
}

function hasKnownCost(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getModelEstimatedCostInr(
  provider: ProviderInfo,
  model: string,
  getEstimatedCostInr?: (
    providerName: string,
    model: string,
  ) => number | undefined,
) {
  const estimated =
    getEstimatedCostInr?.(provider.name, model) ??
    provider.model_estimated_cost_inr?.[model];

  return typeof estimated === "number" && Number.isFinite(estimated)
    ? estimated
    : 0;
}

function getModelHistoricalCostInr(
  provider: ProviderInfo,
  model: string,
  getHistoricalCostInr?: (
    providerName: string,
    model: string,
  ) => number | undefined,
) {
  const historical = getHistoricalCostInr?.(provider.name, model);
  return hasKnownCost(historical) ? historical : null;
}

export function LlmModelSelectionPanel({
  providers,
  selectedKeys,
  selectionMode = "multiple",
  title = "Models",
  emptyMessage = "No configured LLM models are available yet.",
  loading = false,
  loadingRows = 3,
  modelMixControls,
  showBulkActions = true,
  onToggle,
  selectedMultipliers,
  onMultiplierChange,
  onSelectAll,
  onClear,
  onSelectWebCapable,
  onToggleProvider,
  getSelectionConstraint,
  getEstimatedCostInr,
  getHistoricalCostInr,
  costSummaryLabel = "Estimated selected total",
  costSummaryValue,
  historicalCostSummaryLabel = "Previous selected total",
}: LlmModelSelectionPanelProps) {
  const totalModelCount = providers.reduce(
    (total, provider) => total + provider.models.length,
    0,
  );
  const totalSelectableModelCount = providers.reduce((total, provider) => {
    return (
      total +
      provider.models.filter((model) => {
        if (!isCompatible(provider, model)) return false;
        const selectionConstraint = getSelectionConstraint?.(provider, model);
        return selectionConstraint?.selectable !== false;
      }).length
    );
  }, 0);
  const providerCostSummaries = providers.reduce<Record<string, ProviderCostSummary>>(
    (summaries, provider) => {
      summaries[provider.name] = provider.models.reduce<ProviderCostSummary>(
        (summary, model) => {
          const key = getModelKey(provider.name, model);
          if (!selectedKeys.has(key)) return summary;
          const multiplier = Math.max(1, selectedMultipliers?.[key] ?? 1);

          const historicalCostInr = getModelHistoricalCostInr(
            provider,
            model,
            getHistoricalCostInr,
          );
          return {
            selectedCount: summary.selectedCount + multiplier,
            estimatedCostInr:
              summary.estimatedCostInr +
              getModelEstimatedCostInr(provider, model, getEstimatedCostInr) * multiplier,
            historicalCostInr:
              summary.historicalCostInr + (historicalCostInr ?? 0) * multiplier,
          };
        },
        { selectedCount: 0, estimatedCostInr: 0, historicalCostInr: 0 },
      );

      return summaries;
    },
    {},
  );
  const selectedEstimatedCostInr = Object.values(providerCostSummaries).reduce(
    (total, summary) => total + summary.estimatedCostInr,
    0,
  );
  const selectedHistoricalCostInr = Object.values(providerCostSummaries).reduce(
    (total, summary) => total + summary.historicalCostInr,
    0,
  );
  const selectedWebCapableCount = countSelectedWebCapableModels(
    providers,
    selectedKeys,
  );
  const canBulkSelect = selectionMode === "multiple" && Boolean(onSelectAll);
  const canBulkClear = Boolean(onClear);

  return (
    <div className="space-y-4">
      {modelMixControls ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
          {modelMixControls}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold uppercase tracking-[0.12em] text-slate-950">
          {title}
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-indigo-50 px-3 py-1 font-semibold text-indigo-700">
            {selectedKeys.size} / {totalSelectableModelCount || totalModelCount}
          </span>
          <span className="rounded-full bg-sky-50 px-3 py-1 font-semibold text-sky-700 ring-1 ring-sky-100">
            Web-capable selected: {selectedWebCapableCount} / {selectedKeys.size}
          </span>
          <span className="rounded-full bg-emerald-50 px-3 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-100">
            {costSummaryLabel}: {costSummaryValue ?? formatInrCost(selectedEstimatedCostInr)}
          </span>
          {selectedHistoricalCostInr > 0 ? (
            <span className="rounded-full bg-amber-50 px-3 py-1 font-semibold text-amber-700 ring-1 ring-amber-100">
              {historicalCostSummaryLabel}: {formatInrCost(selectedHistoricalCostInr)}
            </span>
          ) : null}
          {showBulkActions && canBulkSelect ? (
            <button
              type="button"
              onClick={onSelectAll}
              disabled={
                totalSelectableModelCount === 0 ||
                selectedKeys.size === totalSelectableModelCount
              }
              className="font-medium text-indigo-600 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              Select all
            </button>
          ) : null}
          {showBulkActions && selectionMode === "multiple" && onSelectWebCapable ? (
            <button
              type="button"
              onClick={onSelectWebCapable}
              disabled={providers.length === 0}
              className="font-medium text-sky-700 hover:text-sky-800 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              Select web-capable only
            </button>
          ) : null}
          {showBulkActions && canBulkClear ? (
            <button
              type="button"
              onClick={onClear}
              disabled={selectedKeys.size === 0}
              className="font-medium text-indigo-600 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              Unselect all
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: loadingRows }).map((_, index) => (
            <div
              key={index}
              className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          {emptyMessage}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {providers.map((provider) => {
            const providerKeys = provider.models.map((model) =>
              getModelKey(provider.name, model),
            );
            const selectedProviderCount = providerKeys.filter((key) =>
              selectedKeys.has(key),
            ).length;
            const compatibleModels = provider.models.filter((model) => {
              if (!isCompatible(provider, model)) return false;
              const selectionConstraint = getSelectionConstraint?.(
                provider,
                model,
              );
              return selectionConstraint?.selectable !== false;
            });
            const allCompatibleChecked =
              compatibleModels.length > 0 &&
              compatibleModels.every((model) =>
                selectedKeys.has(getModelKey(provider.name, model)),
              );
            const someChecked = selectedProviderCount > 0;
            const providerCostSummary = providerCostSummaries[provider.name] ?? {
              selectedCount: 0,
              estimatedCostInr: 0,
              historicalCostInr: 0,
            };

            return (
              <section
                key={provider.name}
                className="border-b border-slate-100 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {selectionMode === "multiple" && onToggleProvider ? (
                      <button
                        type="button"
                        onClick={() =>
                          onToggleProvider(provider.name, compatibleModels)
                        }
                        disabled={compatibleModels.length === 0}
                        aria-label={`Toggle ${provider.name} models`}
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-[4px] border text-xs font-bold transition",
                          allCompatibleChecked || someChecked
                            ? "border-blue-600 bg-blue-600 text-white"
                            : "border-slate-300 bg-white text-transparent",
                          compatibleModels.length === 0 &&
                            "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-300",
                        )}
                      >
                        {allCompatibleChecked ? (
                          <Check className="size-3.5" />
                        ) : someChecked ? (
                          "−"
                        ) : null}
                      </button>
                    ) : (
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-[4px] border text-xs font-bold",
                          someChecked
                            ? "border-blue-600 bg-blue-600 text-white"
                            : "border-slate-300 bg-white text-transparent",
                        )}
                        aria-hidden="true"
                      >
                        {someChecked ? "−" : null}
                      </span>
                    )}
                    <span className="truncate text-lg font-semibold capitalize text-slate-950">
                      {provider.name}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-sm">
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-100">
                      Selected estimate: {formatInrCost(providerCostSummary.estimatedCostInr)}
                    </span>
                    {providerCostSummary.historicalCostInr > 0 ? (
                      <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 ring-1 ring-amber-100">
                        Previous cost: {formatInrCost(providerCostSummary.historicalCostInr)}
                      </span>
                    ) : null}
                    <span className="text-slate-500">
                      {selectedProviderCount} / {provider.models.length}
                    </span>
                  </div>
                </div>

                <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
                  <div className="grid gap-2 md:grid-cols-2">
                    {provider.models.map((model) => {
                      const key = getModelKey(provider.name, model);
                      const selected = selectedKeys.has(key);
                      const multiplier = Math.max(1, selectedMultipliers?.[key] ?? 1);
                      const selectionConstraint = getSelectionConstraint?.(
                        provider,
                        model,
                      );
                      const compatible =
                        isCompatible(provider, model) &&
                        selectionConstraint?.selectable !== false;
                      const internetAccess = getResolvedProviderInternetAccess(
                        provider.name,
                        provider.internet_access,
                      );
                      const lastRunWebUsed =
                        provider.model_last_run_web_search_used?.[model] ?? null;
                      const lastRunWebSources =
                        provider.model_last_run_web_sources?.[model] ?? [];
                      const estimated = getModelEstimatedCostInr(
                        provider,
                        model,
                        getEstimatedCostInr,
                      );
                      const historicalCost = getModelHistoricalCostInr(
                        provider,
                        model,
                        getHistoricalCostInr,
                      );

                      return (
                        <label
                          key={key}
                          title={
                            !compatible
                              ? getCompatibilityReason(
                                  provider,
                                  model,
                                  getSelectionConstraint,
                                )
                              : undefined
                          }
                          className={cn(
                            "flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors",
                            compatible
                              ? "cursor-pointer"
                              : "cursor-not-allowed opacity-55",
                            selected
                              ? "bg-indigo-50 text-indigo-700"
                              : compatible
                                ? "bg-white/30 hover:bg-slate-100"
                                : "bg-slate-100",
                          )}
                        >
                          <input
                            type={
                              selectionMode === "single" ? "radio" : "checkbox"
                            }
                            name="llm-model-selection"
                            checked={selected}
                            disabled={!compatible}
                            onChange={() => onToggle(key)}
                            className="size-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:border-slate-200 disabled:bg-slate-50"
                          />
                          <span
                            className={cn(
                              "min-w-0 flex-1",
                              compatible ? "text-slate-700" : "text-slate-400",
                            )}
                          >
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span
                                className={cn(
                                  "min-w-0 truncate text-sm",
                                  selected ? "font-medium text-slate-800" : "",
                                )}
                              >
                                {model}
                              </span>
                              {internetAccess.mode !== "none" ? (
                                <span
                                  title={getInternetAccessTooltipText(internetAccess)}
                                  className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 ring-1 ring-sky-100"
                                >
                                  {getInternetAccessBadgeText(internetAccess)}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                              {lastRunWebUsed ? (
                                <span
                                  title="The most recent completed run for this model executed at least one live web/search call."
                                  className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 ring-1 ring-emerald-100"
                                >
                                  ✅ Used web last run
                                </span>
                              ) : null}
                              {lastRunWebUsed &&
                              lastRunWebSources.length === 0 ? (
                                <span
                                  title="The most recent completed run used web/search, but no evidence or source URLs were saved."
                                  className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-amber-100"
                                >
                                  ⚠️ No sources last run
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                              <span
                                className={cn(
                                  compatible ? "text-slate-500" : "text-slate-400",
                                  selected && compatible ? "text-slate-600" : "",
                                )}
                              >
                                Est. {formatInrCost(estimated)}
                              </span>
                              {historicalCost !== null ? (
                                <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-amber-100">
                                  Prev. {formatInrCost(historicalCost)}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          {selected && selectionMode === "multiple" && onMultiplierChange ? (
                            <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-indigo-200 bg-white px-2 py-1 text-xs font-extrabold text-indigo-700 shadow-sm" onClick={(event) => event.preventDefault()}>
                              <span aria-hidden="true">×</span>
                              <span className="min-w-4 text-center">{multiplier}</span>
                              <span className="flex flex-col">
                                <button
                                  type="button"
                                  className="rounded text-indigo-600 hover:bg-indigo-50"
                                  aria-label={`Increase ${model} multiplier`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onMultiplierChange(key, multiplier + 1);
                                  }}
                                >
                                  <ChevronUp className="size-3" />
                                </button>
                                <button
                                  type="button"
                                  className="rounded text-indigo-600 hover:bg-indigo-50"
                                  aria-label={`Decrease ${model} multiplier`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onMultiplierChange(key, multiplier - 1);
                                  }}
                                >
                                  <ChevronDown className="size-3" />
                                </button>
                              </span>
                            </span>
                          ) : selected ? (
                            <Check className="size-3.5 shrink-0 text-indigo-600" />
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
