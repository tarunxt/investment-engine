'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiService, APIError } from '@/services/api';
import type { ProviderInfo, ProviderModelTarget } from '@/types/api';

const DEFAULT_EVENT_TARGET: ProviderModelTarget = {
  provider: 'openai',
  model: 'gpt-4o-mini',
};

interface EventScanRunControlsProps {
  buttonClassName?: string;
  buttonLabel?: string;
  defaultTarget?: ProviderModelTarget | null;
  disabled?: boolean;
  onRun: (target: ProviderModelTarget | null) => void | Promise<void>;
  pickerButtonClassName?: string;
  running?: boolean;
}

interface PickerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unable to load models right now.';
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
    return provider.models.includes(target.model) && isCompatibleModel(provider, target.model);
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
  buttonLabel = 'Run Events Scan',
  defaultTarget,
  disabled,
  onRun,
  pickerButtonClassName,
  running,
}: EventScanRunControlsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pickerPanelRef = useRef<HTMLDivElement | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<PickerPosition | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<ProviderModelTarget | null>(null);

  const updatePickerPosition = useCallback(() => {
    if (!containerRef.current || typeof window === 'undefined') {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const viewportPadding = 16;
    const width = Math.min(window.innerWidth - viewportPadding * 2, 896);
    const maxLeft = Math.max(viewportPadding, window.innerWidth - width - viewportPadding);
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
        const data = await apiService.getProviders({ signal: controller.signal });
        if (cancelled) return;
        setProviders(data.filter((provider) => provider.configured));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
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

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target)
        && !pickerPanelRef.current?.contains(target)
      ) {
        setPickerOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;

    updatePickerPosition();

    window.addEventListener('resize', updatePickerPosition);
    window.addEventListener('scroll', updatePickerPosition, true);

    return () => {
      window.removeEventListener('resize', updatePickerPosition);
      window.removeEventListener('scroll', updatePickerPosition, true);
    };
  }, [pickerOpen, updatePickerPosition]);

  const activeTarget = providers.length > 0
    ? (isSelectableTarget(providers, selectedTarget)
      ? selectedTarget
      : getPreferredTarget(providers, defaultTarget))
    : selectedTarget ?? defaultTarget ?? DEFAULT_EVENT_TARGET;

  const selectedCount = activeTarget ? 1 : 0;
  const totalModelCount = providers.reduce((total, provider) => total + provider.models.length, 0);
  const selectedProvider = providers.find((provider) => provider.name === activeTarget?.provider);
  const selectedEstimatedCostInr = selectedProvider && activeTarget
    ? selectedProvider.model_estimated_cost_inr?.[activeTarget.model] ?? 0
    : 0;

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <Button
        onClick={() => void onRun(activeTarget)}
        disabled={disabled || running}
        className={buttonClassName}
      >
        {running ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <Sparkles className="mr-2 size-4" />
        )}
        {buttonLabel}
      </Button>

      <button
        type="button"
        title="Choose LLM model"
        aria-label="Choose LLM model"
        aria-expanded={pickerOpen}
        aria-haspopup="dialog"
        onClick={() => {
          if (!pickerOpen) {
            updatePickerPosition();
          }
          setPickerOpen((current) => !current);
        }}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/8 text-white transition hover:bg-white/14 focus:outline-none focus:ring-2 focus:ring-white/20',
          pickerOpen && 'bg-white/14',
          pickerButtonClassName,
        )}
      >
        <Bot className="size-4" />
      </button>

      {pickerOpen && pickerPosition && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={pickerPanelRef}
            role="dialog"
            aria-label="Choose LLM model"
            className="fixed z-[110] overflow-hidden rounded-[26px] border border-slate-200 bg-white text-slate-900 shadow-[0_28px_70px_-26px_rgba(15,23,42,0.45)]"
            style={{
              top: pickerPosition.top,
              left: pickerPosition.left,
              width: pickerPosition.width,
              maxHeight: pickerPosition.maxHeight,
            }}
          >
            <div className="max-h-full overflow-y-auto p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-medium uppercase tracking-[0.18em] text-slate-900">
                  Models
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex h-7 items-center rounded-full bg-indigo-50 px-3 text-xs font-medium text-indigo-700">
                    {selectedCount} / {totalModelCount}
                  </div>
                  <div className="flex h-7 items-center rounded-full bg-emerald-50 px-3 text-xs font-medium text-emerald-700">
                    Est: ₹{selectedEstimatedCostInr.toFixed(2)}
                  </div>
                </div>
              </div>
              {providerError ? (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {providerError}
                </div>
              ) : null}

              {loadingProviders ? (
                <div className="mt-4 space-y-3">
                  {[1, 2, 3].map((item) => (
                    <div
                      key={item}
                      className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
                    />
                  ))}
                </div>
              ) : providers.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  No configured LLM models are available for this analysis yet.
                </div>
              ) : (
                <div className="mt-4 overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-sm">
                  {providers.map((provider) => {
                    const providerSelectedCount =
                      activeTarget?.provider === provider.name ? 1 : 0;

                    return (
                      <div key={provider.name} className="border-b border-slate-100 last:border-b-0">
                        <div className="flex items-center justify-between px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-blue-600 text-xs font-bold text-white">
                              -
                            </div>
                            <span className="text-[1.05rem] font-medium capitalize text-slate-900">
                              {provider.name}
                            </span>
                          </div>
                          <span className="text-sm text-slate-500">
                            {providerSelectedCount} / {provider.models.length}
                          </span>
                        </div>

                        <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3">
                          <div className="grid gap-2 md:grid-cols-2">
                            {provider.models.map((model) => {
                              const compatibility = provider.model_compatibility?.[model];
                              const isCompatible = compatibility?.compatible !== false;
                              const isSelected = activeTarget?.provider === provider.name
                                && activeTarget.model === model;
                              const estimatedInr = provider.model_estimated_cost_inr?.[model];
                              const costLabel = typeof estimatedInr === 'number'
                                ? ` (₹${estimatedInr.toFixed(2)})`
                                : '';

                              return (
                                <button
                                  key={`${provider.name}::${model}`}
                                  type="button"
                                  title={!isCompatible ? compatibility?.reason || 'Currently unavailable' : undefined}
                                  disabled={!isCompatible}
                                  onClick={() => {
                                    setSelectedTarget({
                                      provider: provider.name,
                                      model,
                                    });
                                  }}
                                  className={cn(
                                    'flex items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors',
                                    isCompatible ? 'cursor-pointer' : 'cursor-not-allowed opacity-55',
                                    isSelected
                                      ? 'bg-indigo-50 text-indigo-700'
                                      : isCompatible
                                        ? 'hover:bg-slate-100'
                                        : 'bg-slate-100',
                                  )}
                                >
                                  <span
                                    className={cn(
                                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                      isSelected
                                        ? 'border-indigo-600 bg-indigo-600'
                                        : 'border-slate-300 bg-white',
                                      !isCompatible && 'border-slate-200 bg-slate-50',
                                    )}
                                  >
                                    {isSelected ? <Check className="size-3 text-white" /> : null}
                                  </span>
                                  <span
                                    className={cn(
                                      'flex-1 truncate text-sm',
                                      isCompatible ? 'text-slate-700' : 'text-slate-400',
                                    )}
                                  >
                                    {model}
                                    {costLabel}
                                  </span>
                                  {isSelected ? <Check className="size-3.5 shrink-0 text-indigo-600" /> : null}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
