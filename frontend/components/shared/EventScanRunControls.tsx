"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiService, APIError } from "@/services/api";
import { LlmModelMixControls } from "@/components/shared/LlmModelMixControls";
import { LlmModelSelectionPanel } from "@/components/shared/LlmModelSelectionPanel";
import type { ProviderInfo, ProviderModelTarget } from "@/types/api";

const DEFAULT_EVENT_TARGET: ProviderModelTarget = {
  provider: "openai",
  model: "gpt-4o-mini",
};
const MODEL_MIX_STORAGE_KEY = "investor:model-mixes:v1";

type SavedModelMix = {
  id: string;
  name: string;
  targets: string[];
  updated_at?: string;
};

interface EventScanRunControlsBaseProps {
  buttonClassName?: string;
  buttonLabel?: string;
  containerClassName?: string;
  defaultTarget?: ProviderModelTarget | null;
  disabled?: boolean;
  historicalEstimatedCostInrByTarget?: Record<string, number>;
  pickerButtonClassName?: string;
  pickerDialogLabel?: string;
  pickerIcon?: ReactNode;
  running?: boolean;
}

type EventScanRunControlsSingleProps = EventScanRunControlsBaseProps & {
  selectionMode?: "single";
  onRun: (target: ProviderModelTarget | null) => void | Promise<void>;
  onRunMultiple?: never;
  defaultTargets?: never;
};

type EventScanRunControlsMultipleProps = EventScanRunControlsBaseProps & {
  selectionMode: "multiple";
  onRunMultiple: (targets: ProviderModelTarget[]) => void | Promise<void>;
  onRun?: never;
  defaultTargets?: ProviderModelTarget[] | null;
};

type EventScanRunControlsProps =
  | EventScanRunControlsSingleProps
  | EventScanRunControlsMultipleProps;

interface PickerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function readSavedModelMixes(): SavedModelMix[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODEL_MIX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (mix) =>
          mix &&
          typeof mix.id === "string" &&
          typeof mix.name === "string" &&
          Array.isArray(mix.targets),
      )
      .map((mix) => ({
        id: mix.id,
        name: mix.name,
        targets: mix.targets.filter(
          (target: unknown) => typeof target === "string",
        ),
        updated_at:
          typeof mix.updated_at === "string" ? mix.updated_at : undefined,
      }));
  } catch {
    return [];
  }
}

function writeSavedModelMixes(mixes: SavedModelMix[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_MIX_STORAGE_KEY, JSON.stringify(mixes));
  } catch {
    // Keep the picker usable if localStorage is unavailable.
  }
}

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unable to load models right now.";
}

function targetKey(target: ProviderModelTarget | null | undefined) {
  if (!target?.provider || !target?.model) return null;
  return `${target.provider}::${target.model}`;
}

function isCompatibleModel(provider: ProviderInfo, model: string) {
  return provider.model_compatibility?.[model]?.compatible !== false;
}

function isSelectableTarget(
  providers: ProviderInfo[],
  target: ProviderModelTarget | null | undefined,
) {
  const key = targetKey(target);
  if (!key) return false;

  return providers.some((provider) => {
    if (!provider.configured || provider.name !== target?.provider) {
      return false;
    }
    return (
      provider.models.includes(target.model) &&
      isCompatibleModel(provider, target.model)
    );
  });
}

function getFirstCompatibleTarget(providers: ProviderInfo[]) {
  for (const provider of providers) {
    if (!provider.configured) continue;

    for (const model of provider.models) {
      if (isCompatibleModel(provider, model)) {
        return {
          provider: provider.name,
          model,
        };
      }
    }
  }
  return null;
}

function getPreferredTarget(
  providers: ProviderInfo[],
  defaultTarget: ProviderModelTarget | null | undefined,
) {
  const candidates = [defaultTarget, DEFAULT_EVENT_TARGET];
  for (const candidate of candidates) {
    if (candidate && isSelectableTarget(providers, candidate)) {
      return candidate;
    }
  }
  return getFirstCompatibleTarget(providers);
}

function getPreferredTargets(
  providers: ProviderInfo[],
  {
    defaultTarget,
    defaultTargets,
  }: {
    defaultTarget?: ProviderModelTarget | null;
    defaultTargets?: ProviderModelTarget[] | null;
  },
) {
  const compatibleTargets: ProviderModelTarget[] = [];
  const seenKeys = new Set<string>();
  const candidates = [
    ...(defaultTargets || []),
    ...(defaultTarget ? [defaultTarget] : []),
  ];

  for (const candidate of candidates) {
    const key = targetKey(candidate);
    if (!candidate || !key || seenKeys.has(key)) continue;
    if (isSelectableTarget(providers, candidate)) {
      compatibleTargets.push(candidate);
      seenKeys.add(key);
    }
  }

  if (compatibleTargets.length > 0) {
    return compatibleTargets;
  }

  const firstCompatibleTarget = getPreferredTarget(providers, defaultTarget);
  return firstCompatibleTarget ? [firstCompatibleTarget] : [];
}

function getTargetsFromKeys(
  providers: ProviderInfo[],
  selectedKeys: Set<string>,
) {
  const targets: ProviderModelTarget[] = [];

  for (const provider of providers) {
    if (!provider.configured) continue;

    for (const model of provider.models) {
      const key = `${provider.name}::${model}`;
      if (
        selectedKeys.has(key) &&
        provider.model_compatibility?.[model]?.compatible !== false
      ) {
        targets.push({ provider: provider.name, model });
      }
    }
  }

  return targets;
}

export function EventScanRunControls({
  buttonClassName,
  buttonLabel = "Run Events Scan",
  containerClassName,
  defaultTarget,
  defaultTargets,
  disabled,
  historicalEstimatedCostInrByTarget,
  pickerButtonClassName,
  pickerDialogLabel = "Select LLMs",
  pickerIcon,
  running,
  selectionMode = "single",
  ...runProps
}: EventScanRunControlsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pickerPanelRef = useRef<HTMLDivElement | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<PickerPosition | null>(
    null,
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [hasTouchedSelection, setHasTouchedSelection] = useState(false);
  const [savedMixes, setSavedMixes] = useState<SavedModelMix[]>(() =>
    readSavedModelMixes(),
  );
  const [selectedMixId, setSelectedMixId] = useState("");

  const persistSavedMixes = useCallback((mixes: SavedModelMix[]) => {
    setSavedMixes(mixes);
    writeSavedModelMixes(mixes);
  }, []);

  const updatePickerPosition = useCallback(() => {
    if (!containerRef.current || typeof window === "undefined") {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const viewportPadding = 16;
    const width = Math.min(
      window.innerWidth - viewportPadding * 2,
      selectionMode === "multiple" ? 760 : 680,
    );
    const maxLeft = Math.max(
      viewportPadding,
      window.innerWidth - width - viewportPadding,
    );
    const left = Math.min(Math.max(viewportPadding, rect.left), maxLeft);
    const top = rect.bottom + 12;
    const maxHeight = Math.max(280, window.innerHeight - top - viewportPadding);

    setPickerPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [selectionMode]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const loadProviders = async () => {
      setLoadingProviders(true);
      setProviderError(null);
      try {
        const data = await apiService.getProviders({
          signal: controller.signal,
        });
        if (cancelled) return;
        setProviders(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setProviderError(normalizeError(err));
      } finally {
        if (!cancelled) {
          setLoadingProviders(false);
        }
      }
    };

    void loadProviders();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    window.setTimeout(() => setSavedMixes(readSavedModelMixes()), 0);

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !pickerPanelRef.current?.contains(target)
      ) {
        setPickerOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPickerOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;

    updatePickerPosition();

    window.addEventListener("resize", updatePickerPosition);
    window.addEventListener("scroll", updatePickerPosition, true);

    return () => {
      window.removeEventListener("resize", updatePickerPosition);
      window.removeEventListener("scroll", updatePickerPosition, true);
    };
  }, [pickerOpen, updatePickerPosition]);

  const activeTarget =
    providers.length > 0
      ? getPreferredTarget(providers, defaultTarget)
      : null;
  const compatibleTargets = new Set(
    providers.flatMap((provider) =>
      provider.models
        .filter(
          (model) =>
            provider.configured &&
            provider.model_compatibility?.[model]?.compatible !== false,
        )
        .map((model) => `${provider.name}::${model}`),
    ),
  );
  const compatibleSelectedKeys = new Set(
    Array.from(selectedKeys).filter((key) => compatibleTargets.has(key)),
  );
  const defaultSelectedKeys = new Set(
    getPreferredTargets(providers, { defaultTarget, defaultTargets })
      .map((target) => targetKey(target))
      .filter((key): key is string => Boolean(key)),
  );
  const effectiveSelectedKeys =
    selectionMode === "multiple"
      ? hasTouchedSelection
        ? compatibleSelectedKeys
        : defaultSelectedKeys
      : compatibleSelectedKeys.size > 0
        ? compatibleSelectedKeys
        : defaultSelectedKeys;
  const activeTargets = getTargetsFromKeys(providers, effectiveSelectedKeys);
  const activeSingleTarget = activeTargets[0] ?? activeTarget;

  const getEstimatedCostInr = useCallback(
    (providerName: string, model: string) =>
      providers.find((provider) => provider.name === providerName)
        ?.model_estimated_cost_inr?.[model],
    [providers],
  );
  const getHistoricalCostInr = useCallback(
    (providerName: string, model: string) => {
      const value =
        historicalEstimatedCostInrByTarget?.[`${providerName}::${model}`];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    },
    [historicalEstimatedCostInrByTarget],
  );
  const modelMixControls = (
    <LlmModelMixControls
      mixes={savedMixes}
      selectedMixId={selectedMixId}
      onApply={(id) => {
        if (!id || id === "none") {
          setSelectedMixId("");
          return;
        }
        const mix = savedMixes.find((item) => item.id === id);
        if (!mix) return;
        const compatibleMixTargets = mix.targets.filter((target) =>
          compatibleTargets.has(target),
        );
        if (compatibleMixTargets.length === 0) {
          window.alert(
            "No models in this mix are compatible with current API access.",
          );
          return;
        }
        if (
          selectionMode === "single" &&
          (compatibleMixTargets.length < mix.targets.length ||
            compatibleMixTargets.length > 1)
        ) {
          window.alert(
            "This chooser runs one LLM at a time, so the first compatible model in the mix was selected.",
          );
        }
        setHasTouchedSelection(true);
        setSelectedKeys(
          new Set(
            selectionMode === "multiple"
              ? compatibleMixTargets
              : compatibleMixTargets.slice(0, 1),
          ),
        );
        setSelectedMixId(id);
      }}
      onSave={() => {
        const targetsToSave = Array.from(effectiveSelectedKeys);
        if (targetsToSave.length === 0) {
          window.alert(
            selectionMode === "multiple"
              ? "Select at least one model before saving a mix."
              : "Select a model before saving a mix.",
          );
          return;
        }
        const name = window.prompt("Name this model mix:");
        if (!name) return;
        const cleaned = name.trim();
        if (!cleaned) return;
        const now = new Date().toISOString();
        const targets = targetsToSave;
        const existing = savedMixes.find(
          (mix) => mix.name.toLowerCase() === cleaned.toLowerCase(),
        );
        if (existing) {
          const updated = {
            ...existing,
            name: cleaned,
            targets,
            updated_at: now,
          };
          persistSavedMixes(
            savedMixes.map((mix) => (mix.id === existing.id ? updated : mix)),
          );
          setSelectedMixId(existing.id);
          return;
        }
        const created = {
          id: `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          name: cleaned,
          targets,
          updated_at: now,
        };
        persistSavedMixes([created, ...savedMixes]);
        setSelectedMixId(created.id);
      }}
      onEdit={() => {
        if (!selectedMixId) return;
        const current = savedMixes.find((mix) => mix.id === selectedMixId);
        if (!current) return;
        const name = window.prompt("Edit model mix name:", current.name);
        if (!name?.trim()) return;
        persistSavedMixes(
          savedMixes.map((mix) =>
            mix.id === selectedMixId
              ? {
                  ...mix,
                  name: name.trim(),
                  updated_at: new Date().toISOString(),
                }
              : mix,
          ),
        );
      }}
      onDelete={() => {
        if (!selectedMixId) return;
        const current = savedMixes.find((mix) => mix.id === selectedMixId);
        if (
          !window.confirm(`Delete model mix "${current?.name || selectedMixId}"?`)
        ) {
          return;
        }
        persistSavedMixes(savedMixes.filter((mix) => mix.id !== selectedMixId));
        setSelectedMixId("");
      }}
    />
  );

  const runButtonLoading = Boolean(running);
  const runButtonDisabled = Boolean(disabled || running);
  const runButtonLabel = running
    ? /^Run\b/i.test(buttonLabel)
      ? buttonLabel.replace(/^Run\b/i, "Running")
      : `Running ${buttonLabel}`
    : buttonLabel;

  return (
    <div
      ref={containerRef}
      className={cn("relative flex items-center gap-2", containerClassName)}
    >
      <Button
        onClick={() => {
          if (selectionMode === "multiple" && "onRunMultiple" in runProps) {
            void runProps.onRunMultiple?.(activeTargets);
            return;
          }
          if ("onRun" in runProps) {
            void runProps.onRun?.(activeSingleTarget);
          }
        }}
        disabled={runButtonDisabled}
        aria-busy={runButtonLoading}
        className={buttonClassName}
      >
        {runButtonLoading ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <Sparkles className="mr-2 size-4" />
        )}
        {runButtonLabel}
      </Button>

      <button
        type="button"
        title={pickerDialogLabel}
        aria-label={pickerDialogLabel}
        aria-expanded={pickerOpen}
        aria-haspopup="dialog"
        onClick={() => {
          if (!pickerOpen) {
            updatePickerPosition();
          }
          setPickerOpen((current) => !current);
        }}
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/8 text-white transition hover:bg-white/14 focus:outline-none focus:ring-2 focus:ring-white/20",
          pickerOpen && "bg-white/14",
          pickerButtonClassName,
        )}
      >
        {pickerIcon ?? <Bot className="size-4" />}
      </button>

      {pickerOpen && pickerPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={pickerPanelRef}
              role="dialog"
              aria-label={pickerDialogLabel}
              className="fixed z-[110] overflow-hidden rounded-[26px] border border-slate-200 bg-white text-slate-900 shadow-[0_28px_70px_-26px_rgba(15,23,42,0.45)]"
              style={{
                top: pickerPosition.top,
                left: pickerPosition.left,
                width: pickerPosition.width,
                maxHeight: pickerPosition.maxHeight,
              }}
            >
              <div className="flex max-h-full flex-col">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-slate-950">
                      {pickerDialogLabel}
                    </h2>
                    <p className="text-sm text-slate-500">
                      {selectionMode === "multiple"
                        ? "Choose one or more models for this run."
                        : "Choose the model for this run."}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPickerOpen(false)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                    aria-label="Close LLM selector"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="max-h-full overflow-y-auto px-4 pb-4 pt-4">
                  {providerError ? (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {providerError}
                    </div>
                  ) : null}
                  <LlmModelSelectionPanel
                    providers={providers}
                    selectedKeys={effectiveSelectedKeys}
                    selectionMode={selectionMode}
                    loading={loadingProviders}
                    emptyMessage="No configured LLM models are available for this analysis yet."
                    showBulkActions={selectionMode === "multiple"}
                    modelMixControls={modelMixControls}
                    onToggle={(key) => {
                      setHasTouchedSelection(true);
                      if (selectionMode === "multiple") {
                        setSelectedKeys((current) => {
                          const next = new Set(current);
                          if (next.has(key)) {
                            next.delete(key);
                          } else {
                            next.add(key);
                          }
                          return next;
                        });
                        return;
                      }
                      setSelectedKeys(new Set([key]));
                    }}
                    onSelectAll={
                      selectionMode === "multiple"
                        ? () => {
                            setHasTouchedSelection(true);
                            setSelectedKeys(new Set(compatibleTargets));
                          }
                        : undefined
                    }
                    onClear={
                      selectionMode === "multiple"
                        ? () => {
                            setHasTouchedSelection(true);
                            setSelectedKeys(new Set());
                          }
                        : undefined
                    }
                    onToggleProvider={
                      selectionMode === "multiple"
                        ? (providerName, models) => {
                            setHasTouchedSelection(true);
                            setSelectedKeys((current) => {
                              const next = new Set(current);
                              const providerKeys = models.map(
                                (model) => `${providerName}::${model}`,
                              );
                              const allSelected =
                                providerKeys.length > 0 &&
                                providerKeys.every((key) => next.has(key));

                              providerKeys.forEach((providerKey) => {
                                if (allSelected) {
                                  next.delete(providerKey);
                                } else {
                                  next.add(providerKey);
                                }
                              });

                              return next;
                            });
                          }
                        : undefined
                    }
                    getEstimatedCostInr={getEstimatedCostInr}
                    getHistoricalCostInr={getHistoricalCostInr}
                  />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
