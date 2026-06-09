"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";

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
  onSelectAll?: () => void;
  onClear?: () => void;
  onToggleProvider?: (providerName: string, models: string[]) => void;
  getEstimatedCostInr?: (
    providerName: string,
    model: string,
  ) => number | undefined;
  costSummaryLabel?: string;
  costSummaryValue?: string;
}

type ProviderCostSummary = {
  selectedCount: number;
  estimatedCostInr: number;
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

function getCompatibilityReason(provider: ProviderInfo, model: string) {
  if (!provider.configured) return "Provider is not configured.";
  return (
    provider.model_compatibility?.[model]?.reason || "Currently unavailable."
  );
}

function formatInrCost(cost: number) {
  return `₹${cost.toFixed(2)}`;
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
  onSelectAll,
  onClear,
  onToggleProvider,
  getEstimatedCostInr,
  costSummaryLabel = "Estimated selected total",
  costSummaryValue,
}: LlmModelSelectionPanelProps) {
  const totalModelCount = providers.reduce(
    (total, provider) => total + provider.models.length,
    0,
  );
  const providerCostSummaries = providers.reduce<Record<string, ProviderCostSummary>>(
    (summaries, provider) => {
      summaries[provider.name] = provider.models.reduce<ProviderCostSummary>(
        (summary, model) => {
          const key = getModelKey(provider.name, model);
          if (!selectedKeys.has(key)) return summary;

          return {
            selectedCount: summary.selectedCount + 1,
            estimatedCostInr:
              summary.estimatedCostInr +
              getModelEstimatedCostInr(provider, model, getEstimatedCostInr),
          };
        },
        { selectedCount: 0, estimatedCostInr: 0 },
      );

      return summaries;
    },
    {},
  );
  const selectedEstimatedCostInr = Object.values(providerCostSummaries).reduce(
    (total, summary) => total + summary.estimatedCostInr,
    0,
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
            {selectedKeys.size} / {totalModelCount}
          </span>
          <span className="rounded-full bg-emerald-50 px-3 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-100">
            {costSummaryLabel}: {costSummaryValue ?? formatInrCost(selectedEstimatedCostInr)}
          </span>
          {showBulkActions && canBulkSelect ? (
            <button
              type="button"
              onClick={onSelectAll}
              disabled={
                totalModelCount === 0 || selectedKeys.size === totalModelCount
              }
              className="font-medium text-indigo-600 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              Select all
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
            const compatibleModels = provider.models.filter((model) =>
              isCompatible(provider, model),
            );
            const allCompatibleChecked =
              compatibleModels.length > 0 &&
              compatibleModels.every((model) =>
                selectedKeys.has(getModelKey(provider.name, model)),
              );
            const someChecked = selectedProviderCount > 0;
            const providerCostSummary = providerCostSummaries[provider.name] ?? {
              selectedCount: 0,
              estimatedCostInr: 0,
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
                      const compatible = isCompatible(provider, model);
                      const estimated = getModelEstimatedCostInr(
                        provider,
                        model,
                        getEstimatedCostInr,
                      );
                      const costLabel = ` · Est. ${formatInrCost(estimated)}`;

                      return (
                        <label
                          key={key}
                          title={
                            !compatible
                              ? getCompatibilityReason(provider, model)
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
                              "min-w-0 flex-1 truncate text-sm",
                              compatible ? "text-slate-700" : "text-slate-400",
                              selected && "font-medium text-slate-800",
                            )}
                          >
                            {model}
                            {costLabel}
                          </span>
                          {selected ? (
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
