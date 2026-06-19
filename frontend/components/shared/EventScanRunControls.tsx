"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, Sparkles } from "lucide-react";

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

interface EventScanRunControlsProps {
  buttonClassName?: string;
  buttonLabel?: string;
  containerClassName?: string;
  defaultTarget?: ProviderModelTarget | null;
  disabled?: boolean;
  historicalEstimatedCostInrByTarget?: Record<string, number>;
  onRun: (target: ProviderModelTarget | null) => void | Promise<void>;
  pickerButtonClassName?: string;
  pickerDialogLabel?: string;
  pickerIcon?: ReactNode;
  running?: boolean;
}

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

export function EventScanRunControls({
  buttonClassName,
  buttonLabel = "Run Events Scan",
  containerClassName,
  defaultTarget,
  disabled,
  historicalEstimatedCostInrByTarget,
  onRun,
  pickerButtonClassName,
  pickerDialogLabel = "Choose LLM model",
  pickerIcon,
  running,
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
  const [selectedTarget, setSelectedTarget] =
    useState<ProviderModelTarget | null>(null);
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
    const width = Math.min(window.innerWidth - viewportPadding * 2, 896);
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
  }, []);

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
      ? isSelectableTarget(providers, selectedTarget)
        ? selectedTarget
        : getPreferredTarget(providers, defaultTarget)
      : null;

  const selectedProvider = providers.find(
    (provider) => provider.name === activeTarget?.provider,
  );
  const getEstimatedCostInr = useCallback(
    (providerName: string, model: string) => {
      const override =
        historicalEstimatedCostInrByTarget?.[`${providerName}::${model}`];
      if (typeof override === "number" && Number.isFinite(override)) {
        return override;
      }
      return selectedProvider?.name === providerName
        ? selectedProvider.model_estimated_cost_inr?.[model]
        : providers.find((provider) => provider.name === providerName)
            ?.model_estimated_cost_inr?.[model];
    },
    [historicalEstimatedCostInrByTarget, providers, selectedProvider],
  );
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
  const activeTargetKey = targetKey(activeTarget);
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
        const [firstTarget] = compatibleMixTargets;
        if (!firstTarget) {
          window.alert(
            "No models in this mix are compatible with current API access.",
          );
          return;
        }
        if (
          compatibleMixTargets.length < mix.targets.length ||
          compatibleMixTargets.length > 1
        ) {
          window.alert(
            "This chooser runs one LLM at a time, so the first compatible model in the mix was selected.",
          );
        }
        const [provider, model] = firstTarget.split("::");
        if (!provider || !model) return;
        setSelectedTarget({ provider, model });
        setSelectedMixId(id);
      }}
      onSave={() => {
        if (!activeTargetKey) {
          window.alert("Select a model before saving a mix.");
          return;
        }
        const name = window.prompt("Name this model mix:");
        if (!name) return;
        const cleaned = name.trim();
        if (!cleaned) return;
        const now = new Date().toISOString();
        const targets = [activeTargetKey];
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
        onClick={() => void onRun(activeTarget)}
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
              <div className="max-h-full overflow-y-auto p-4">
                {providerError ? (
                  <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {providerError}
                  </div>
                ) : null}
                <div className="mt-4">
                  <LlmModelSelectionPanel
                    providers={providers}
                    selectedKeys={
                      activeTarget
                        ? new Set([
                            `${activeTarget.provider}::${activeTarget.model}`,
                          ])
                        : new Set()
                    }
                    selectionMode="single"
                    loading={loadingProviders}
                    emptyMessage="No configured LLM models are available for this analysis yet."
                    showBulkActions={false}
                    modelMixControls={modelMixControls}
                    onToggle={(key) => {
                      const [provider, model] = key.split("::");
                      if (!provider || !model) return;
                      setSelectedTarget({ provider, model });
                    }}
                    getEstimatedCostInr={getEstimatedCostInr}
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
