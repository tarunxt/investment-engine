'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from 'react';
import { AlertCircle, CalendarClock, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import { isRunInSwingTradeMarket } from '@/lib/runPresentation';
import { inferRebalanceMarketFromPrompt } from '@/lib/rebalance';
import { apiService } from '@/services/api';
import { type PromptResponse, type ProviderInfo, type RunListItem, type RunModelTarget, type RunResponse } from '@/types/api';
import { useRuns } from '@/hooks/useRuns';
import { type SwingTradeMarket } from '@/lib/swingTrade';

export const DASHBOARD_RUN_LIMIT = 50;
export const TEMPLATE_DEBOUNCE_MS = 300;
export const PROMPT_MAX_CHARS = 60000;
export const PROMPT_WARN_CHARS = 50000;
export const INDIA_TIMEZONE = 'Asia/Kolkata';
const RUN_PROMPT_PREVIEW_CHARS = 280;
export const DEFAULT_TEMPLATE_NAME = 'India Swing-Trade Research';
export const DEFAULT_EXPORT_SPREADSHEET_URL = '';

export interface DashboardPromptPreset {
  initialInvestmentAmount: string;
  buildPrompt: (investmentAmount: string) => string;
  syncPrompt?: (
    currentPrompt: string,
    previousInvestmentAmount: string,
    nextInvestmentAmount: string,
  ) => string;
}

export const STATUS_STYLES: Record<string, string> = {
  scheduled: 'bg-violet-50 text-violet-700 ring-violet-200',
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
};

export const STATUS_ICONS: Record<string, ElementType> = {
  scheduled: CalendarClock,
  pending: Clock3,
  processing: Loader2,
  completed: CheckCircle2,
  failed: AlertCircle,
};

function toRunPromptPreview(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= RUN_PROMPT_PREVIEW_CHARS) return normalized;
  return `${normalized.slice(0, RUN_PROMPT_PREVIEW_CHARS).trimEnd()}...`;
}

function toRunListItem(run: RunResponse): RunListItem {
  return {
    id: run.id,
    prompt_preview: toRunPromptPreview(run.prompt),
    prompt_id: run.prompt_id,
    status: run.status,
    current_stage: run.current_stage,
    run_jobs: run.run_jobs,
    auto_export_enabled: run.auto_export_enabled,
    export_status: run.export_status,
    export_error: run.export_error,
    exported_at: run.exported_at,
    exported_sheet_url: run.exported_sheet_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

interface DashboardContextValue {
  // Runs feed
  runs: RunListItem[];
  runsTotal: number;
  loadingRuns: boolean;
  runsError: string | null;
  lastUpdated: Date | null;
  refreshRuns: () => void;
  setRunsError: (error: string | null) => void;
  runScopeMarket: SwingTradeMarket | null;
  runScopeLabel: string | null;
  runScopeKind: 'swingTrade' | 'rebalance';

  // Form state
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  providers: ProviderInfo[];
  scheduledAt: string;
  setScheduledAt: (val: string) => void;
  submitting: boolean;
  submitError: string | null;
  promptTemplates: PromptResponse[];
  selectedTemplateId: string;
  templateSearch: string;
  isLoading: boolean;
  selectedTargets: Set<string>;
  savedModelMixes: ModelMix[];
  selectedModelMixId: string;
  promptRef: React.RefObject<HTMLTextAreaElement>;

  // Google Sheets export
  autoExportEnabled: boolean;
  setAutoExportEnabled: (val: boolean) => void;
  exportSpreadsheetUrl: string;
  setExportSpreadsheetUrl: (val: string) => void;
  exportSheetName: string;
  setExportSheetName: (val: string) => void;
  exportInvestmentAmount: string;
  setExportInvestmentAmount: (val: string) => void;
  exportTitle: string;
  setExportTitle: (val: string) => void;
  googleSheetsConnected: boolean;
  refreshGoogleSheetsStatus: () => Promise<void>;

  // Derived
  charCount: number;
  charOverLimit: boolean;
  charNearLimit: boolean;
  totalAvailableTargets: number;

  // Handlers
  handleSubmit: (e: React.SubmitEvent<HTMLFormElement>) => Promise<void>;
  handlePromptChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleTemplateChange: (id: string) => void;
  handleTemplateSearch: (q: string) => void;
  toggleTarget: (key: string) => void;
  toggleAllForProvider: (providerName: string, providerModels: string[]) => void;
  selectAllTargets: () => void;
  unselectAllTargets: () => void;
  applyModelMix: (id: string) => void;
  saveModelMix: (name: string) => string | null;
  renameModelMix: (id: string, name: string) => void;
  deleteModelMix: (id: string) => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

const MODEL_MIX_STORAGE_KEY = 'investor:model-mixes:v1';
const COMPATIBLE_MODEL_MIX_ID = 'compatible-models-system';

interface ModelMix {
  id: string;
  name: string;
  targets: string[];
  updated_at: string;
  locked?: boolean;
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

interface DashboardProviderProps {
  children: ReactNode;
  defaultTemplateName?: string | null;
  promptPreset?: DashboardPromptPreset | null;
  defaultExportSheetName?: string | null;
  runScopeMarket?: SwingTradeMarket | null;
  runScopeLabel?: string | null;
  runScopeKind?: 'swingTrade' | 'rebalance';
}

export function DashboardProvider({
  children,
  defaultTemplateName = DEFAULT_TEMPLATE_NAME,
  promptPreset = null,
  defaultExportSheetName = null,
  runScopeMarket = null,
  runScopeLabel = null,
  runScopeKind = 'swingTrade',
}: DashboardProviderProps) {
  const {
    runs,
    setRuns,
    total: runsTotal,
    setTotal: setRunsTotal,
    loading: loadingRuns,
    error: runsError,
    setError: setRunsError,
    lastUpdated,
    refresh: refreshRuns,
  } = useRuns({ limit: DASHBOARD_RUN_LIMIT });

  const [prompt, setPrompt] = useState(() =>
    promptPreset ? promptPreset.buildPrompt(promptPreset.initialInvestmentAmount) : '',
  );
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptResponse[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [savedModelMixes, setSavedModelMixes] = useState<ModelMix[]>([]);
  const [selectedModelMixId, setSelectedModelMixId] = useState('');

  // Google Sheets export state (auto-generated with day-wise tabs)
  const [autoExportEnabled, setAutoExportEnabled] = useState(true);
  const [exportSpreadsheetUrl, setExportSpreadsheetUrl] = useState(DEFAULT_EXPORT_SPREADSHEET_URL);
  const [exportSheetName, setExportSheetName] = useState(() => {
    if (defaultExportSheetName?.trim()) {
      return defaultExportSheetName.trim();
    }
    const today = new Date();
    return today.toLocaleDateString('en-IN', {
      timeZone: INDIA_TIMEZONE,
      month: 'short',
      day: 'numeric',
    });
  });
  const [exportInvestmentAmount, setExportInvestmentAmount] = useState(
    () => promptPreset?.initialInvestmentAmount ?? '',
  );
  const [exportTitle, setExportTitle] = useState('');
  const [googleSheetsConnected, setGoogleSheetsConnected] = useState(false);

  const refreshGoogleSheetsStatus = useCallback(async () => {
    try {
      const sheetsStatus = await apiService.googleSheetsStatus();
      const connected = Boolean(sheetsStatus.connected);
      setGoogleSheetsConnected(connected);
      setExportSpreadsheetUrl(connected ? (sheetsStatus.default_spreadsheet_url ?? '') : '');
    } catch (err) {
      console.error('Failed to load Google Sheets status:', err);
      setGoogleSheetsConnected(false);
      setExportSpreadsheetUrl('');
    }
  }, []);

  const templateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const templateControllerRef = useRef<AbortController | null>(null);
  const providerControllerRef = useRef<AbortController | null>(null);
  const providerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null!);
  const presetPromptRef = useRef(
    promptPreset ? promptPreset.buildPrompt(promptPreset.initialInvestmentAmount) : '',
  );
  const presetAmountRef = useRef(promptPreset?.initialInvestmentAmount ?? '');

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MODEL_MIX_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const sanitized: ModelMix[] = parsed
        .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.targets))
        .map((m) => ({
          id: m.id,
          name: m.name,
          targets: m.targets.filter((t: unknown) => typeof t === 'string'),
          updated_at: typeof m.updated_at === 'string' ? m.updated_at : new Date().toISOString(),
        }));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedModelMixes(sanitized);
    } catch (err) {
      console.warn('Failed to load saved model mixes:', err);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODEL_MIX_STORAGE_KEY, JSON.stringify(savedModelMixes));
    } catch (err) {
      console.warn('Failed to persist model mixes:', err);
    }
  }, [savedModelMixes]);

  useEffect(() => {
    if (providers.length === 0) return;
    const compatibleTargets = providers.flatMap((provider) =>
      provider.models
        .filter((model) => provider.model_compatibility?.[model]?.compatible !== false)
        .map((model) => `${provider.name}::${model}`),
    );
    const systemMix: ModelMix = {
      id: COMPATIBLE_MODEL_MIX_ID,
      name: 'Compatible models',
      targets: compatibleTargets,
      updated_at: new Date().toISOString(),
      locked: true,
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedModelMixes((prev) => {
      const withoutSystem = prev.filter((mix) => mix.id !== COMPATIBLE_MODEL_MIX_ID);
      return [systemMix, ...withoutSystem];
    });
  }, [providers]);

  const initDashboard = useCallback(async () => {
    setIsLoading(true);
    const controller = new AbortController();

    const [providersRes, templatesRes, sheetsStatusRes] = await Promise.allSettled([
      apiService.getProviders({ signal: controller.signal, prompt }),
      apiService.getPrompts({ q: '' }, controller.signal),
      apiService.googleSheetsStatus(),
    ]);

    if (providersRes.status === 'fulfilled') {
      const data = providersRes.value as ProviderInfo[];
      setProviders(data);
      setSelectedTargets(
        new Set(
          data.flatMap((p) =>
            p.models
              .filter((m) => p.model_compatibility?.[m]?.compatible !== false)
              .map((m) => `${p.name}::${m}`),
          ),
        ),
      );
    } else if (providersRes.reason?.name !== 'AbortError') {
      console.error('Failed to load providers:', providersRes.reason);
    }

    if (templatesRes.status === 'fulfilled') {
      const templates = templatesRes.value;
      setPromptTemplates(templates);
      const defaultTemplate = defaultTemplateName
        ? templates.find((tpl) => tpl.name === defaultTemplateName)
        : undefined;
      if (defaultTemplate) {
        setSelectedTemplateId(String(defaultTemplate.id));
        setPrompt(defaultTemplate.body);
      }
    }

    if (sheetsStatusRes.status === 'fulfilled') {
      const sheetsStatus = sheetsStatusRes.value;
      const connected = Boolean(sheetsStatus.connected);
      setGoogleSheetsConnected(connected);
      setExportSpreadsheetUrl(connected ? (sheetsStatus.default_spreadsheet_url ?? '') : '');
    } else {
      console.error('Failed to load Google Sheets status:', sheetsStatusRes.reason);
      setGoogleSheetsConnected(false);
      setExportSpreadsheetUrl('');
    }

    setIsLoading(false);
  }, [defaultTemplateName, prompt]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    initDashboard();
    return () => templateControllerRef.current?.abort('Cleanup');
  }, [initDashboard]);

  useEffect(() => {
    if (!prompt.trim()) return;
    if (providerDebounceRef.current) clearTimeout(providerDebounceRef.current);
    providerDebounceRef.current = setTimeout(async () => {
      providerControllerRef.current?.abort('New provider cost request started');
      const controller = new AbortController();
      providerControllerRef.current = controller;
      try {
        const data = await apiService.getProviders({ signal: controller.signal, prompt });
        setProviders(data);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to refresh provider costs:', err);
      }
    }, 450);

    return () => {
      if (providerDebounceRef.current) clearTimeout(providerDebounceRef.current);
    };
  }, [prompt]);

  useEffect(() => {
    if (!promptPreset) return;

    const nextAmount = exportInvestmentAmount.trim() || promptPreset.initialInvestmentAmount;
    const previousAmount = presetAmountRef.current || promptPreset.initialInvestmentAmount;
    const previousGeneratedPrompt = presetPromptRef.current;
    const nextGeneratedPrompt = promptPreset.buildPrompt(nextAmount);

    setPrompt((current) => {
      if (!current.trim() || current === previousGeneratedPrompt) {
        return nextGeneratedPrompt;
      }

      if (promptPreset.syncPrompt) {
        return promptPreset.syncPrompt(current, previousAmount, nextAmount);
      }

      return current;
    });

    presetAmountRef.current = nextAmount;
    presetPromptRef.current = nextGeneratedPrompt;
  }, [exportInvestmentAmount, promptPreset]);

  const fetchTemplates = useCallback(async (q: string) => {
    templateControllerRef.current?.abort('New search started');
    const controller = new AbortController();
    templateControllerRef.current = controller;
    try {
      const data = await apiService.getPrompts({ q: q.trim() || undefined }, controller.signal);
      setPromptTemplates(data);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('Template search failed:', err);
    }
  }, []);

  const handleTemplateSearch = useCallback(
    (q: string) => {
      setTemplateSearch(q);
      if (templateDebounceRef.current) clearTimeout(templateDebounceRef.current);
      templateDebounceRef.current = setTimeout(() => fetchTemplates(q), TEMPLATE_DEBOUNCE_MS);
    },
    [fetchTemplates],
  );

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
  }, []);

  const handleTemplateChange = useCallback(
    (id: string) => {
      if (id === 'none') return;
      setSelectedTemplateId(id);
      const tpl = promptTemplates.find((p) => String(p.id) === id);
      if (tpl) setPrompt(tpl.body);
    },
    [promptTemplates],
  );

  const toggleTarget = useCallback((key: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllForProvider = useCallback(
    (providerName: string, providerModels: string[]) => {
      const provider = providers.find((p) => p.name === providerName);
      const keys = providerModels
        .filter((m) => provider?.model_compatibility?.[m]?.compatible !== false)
        .map((m) => `${providerName}::${m}`);
      const allChecked = keys.every((k) => selectedTargets.has(k));
      setSelectedTargets((prev) => {
        const next = new Set(prev);
        if (allChecked) keys.forEach((k) => next.delete(k));
        else keys.forEach((k) => next.add(k));
        return next;
      });
    },
    [providers, selectedTargets],
  );

  const selectAllTargets = useCallback(() => {
    setSelectedTargets(
      new Set(
        providers.flatMap((provider) =>
          provider.models
            .filter((model) => provider.model_compatibility?.[model]?.compatible !== false)
            .map((model) => `${provider.name}::${model}`),
        ),
      ),
    );
  }, [providers]);

  const unselectAllTargets = useCallback(() => {
    setSelectedTargets(new Set());
  }, []);

  const applyModelMix = useCallback(
    (id: string) => {
      if (!id || id === 'none') {
        setSelectedModelMixId('');
        return;
      }
      const mix = savedModelMixes.find((m) => m.id === id);
      if (!mix) return;
      const allowed = new Set(providers.flatMap((provider) => provider.models.map((model) => `${provider.name}::${model}`)));
      const compatible = new Set(
        providers.flatMap((provider) =>
          provider.models
            .filter((model) => provider.model_compatibility?.[model]?.compatible !== false)
            .map((model) => `${provider.name}::${model}`),
        ),
      );
      const filtered = mix.targets.filter((target) => allowed.has(target) && compatible.has(target));
      if (filtered.length < mix.targets.length) {
        window.alert('Some models in this mix are incompatible with current API access and were skipped.');
      }
      setSelectedTargets(new Set(filtered));
      setSelectedModelMixId(id);
    },
    [providers, savedModelMixes],
  );

  const saveModelMix = useCallback(
    (name: string) => {
      const cleaned = name.trim();
      if (!cleaned) return null;
      const targets = Array.from(selectedTargets);
      if (targets.length === 0) return null;
      const now = new Date().toISOString();

      const existing = savedModelMixes.find((m) => m.name.toLowerCase() === cleaned.toLowerCase());
      if (existing) {
        const updated: ModelMix = { ...existing, targets, updated_at: now, name: cleaned };
        setSavedModelMixes((prev) => prev.map((m) => (m.id === existing.id ? updated : m)));
        setSelectedModelMixId(existing.id);
        return existing.id;
      }

      const id = `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const created: ModelMix = { id, name: cleaned, targets, updated_at: now };
      setSavedModelMixes((prev) => [created, ...prev]);
      setSelectedModelMixId(id);
      return id;
    },
    [savedModelMixes, selectedTargets],
  );

  const renameModelMix = useCallback((id: string, name: string) => {
    const cleaned = name.trim();
    if (!cleaned) return;
    setSavedModelMixes((prev) =>
      prev.map((mix) => (mix.id === id ? { ...mix, name: cleaned, updated_at: new Date().toISOString() } : mix)),
    );
  }, []);

  const deleteModelMix = useCallback(
    (id: string) => {
      setSavedModelMixes((prev) => prev.filter((mix) => mix.id !== id));
      if (selectedModelMixId === id) setSelectedModelMixId('');
    },
    [selectedModelMixId],
  );

  const parseTargets = useCallback(
    (): RunModelTarget[] =>
      Array.from(selectedTargets).map((key) => {
        const [p, m] = key.split('::');

        return {
          provider: p,
          model: m,
        };
      }),
    [selectedTargets]
  );


  const isRunInCurrentScope = useCallback(
    (promptPreview: string | null | undefined) => {
      if (!runScopeMarket) return true;
      if (runScopeKind === 'rebalance') {
        return inferRebalanceMarketFromPrompt(promptPreview) === runScopeMarket;
      }
      return isRunInSwingTradeMarket(promptPreview, runScopeMarket);
    },
    [runScopeKind, runScopeMarket],
  );

  const handleSubmit = useCallback(
    async (event: React.SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) {
        setSubmitError('Prompt is required.');
        return;
      }
      const targets = parseTargets();
      if (targets.length === 0) {
        setSubmitError('Select at least one model for Stage 1.');
        return;
      }
      if (autoExportEnabled && !googleSheetsConnected) {
        setSubmitError('Connect Google Sheets first, then run with auto-export enabled.');
        return;
      }
      if (autoExportEnabled && !exportSpreadsheetUrl.trim()) {
        setSubmitError('Set your personal Google Sheet first from Google Sheets settings.');
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const hasActiveRun = runs.some((run) =>
          ['scheduled', 'pending', 'processing'].includes((run.status || '').toLowerCase()) &&
          isRunInCurrentScope(run.prompt_preview),
        );
        let allowParallel = false;
        if (hasActiveRun) {
          allowParallel = window.confirm(
            'A job is already running. Do you want to run another job in parallel?',
          );
          if (!allowParallel) {
            setSubmitting(false);
            return;
          }
        }

        const run = await apiService.createRun({
          prompt: trimmedPrompt,
          targets,
          scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          allow_parallel: allowParallel,
          auto_export_enabled: autoExportEnabled,
          export_spreadsheet_url:
            autoExportEnabled ? (exportSpreadsheetUrl.trim() || undefined) : undefined,
          export_sheet_name: autoExportEnabled ? (exportSheetName.trim() || undefined) : undefined,
          export_investment_amount: autoExportEnabled ? exportInvestmentAmount || undefined : undefined,
          export_title: autoExportEnabled ? exportTitle || undefined : undefined,
        });
        setScheduledAt('');
        promptRef.current?.focus();
        // Prepend the new run as a single entry — one row per job submission
        setRuns((current) => [toRunListItem(run), ...current].slice(0, DASHBOARD_RUN_LIMIT));
        setRunsTotal((t) => t + 1);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to create job');
      } finally {
        setSubmitting(false);
      }
    },
    [
      prompt,
      runs,
      parseTargets,
      scheduledAt,
      autoExportEnabled,
      exportSpreadsheetUrl,
      exportSheetName,
      exportInvestmentAmount,
      exportTitle,
      googleSheetsConnected,
      isRunInCurrentScope,
      setRuns,
      setRunsTotal,
    ],
  );

  const charCount = prompt.length;
  const charOverLimit = charCount > PROMPT_MAX_CHARS;
  const charNearLimit = charCount > PROMPT_WARN_CHARS && !charOverLimit;
  const totalAvailableTargets = providers.reduce((n, p) => n + p.models.length, 0);

  useEffect(() => {
    const defaultTemplate = defaultTemplateName
      ? promptTemplates.find((tpl) => tpl.name === defaultTemplateName)
      : undefined;
    if (!defaultTemplate) return;
    if (!selectedTemplateId || selectedTemplateId === 'none') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedTemplateId(String(defaultTemplate.id));
    }
    if (!prompt.trim()) setPrompt(defaultTemplate.body);
  }, [defaultTemplateName, selectedTemplateId, promptTemplates, prompt]);

  useEffect(() => {
    if (!submitError) return;
    if (submitError === 'Prompt is required.' && prompt.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSubmitError(null);
      return;
    }
    if (submitError.includes('Select at least one model') && selectedTargets.size > 0) {
      setSubmitError(null);
      return;
    }
    if (submitError.includes('Connect Google Sheets first') && googleSheetsConnected) {
      setSubmitError(null);
      return;
    }
    if (submitError.includes('Set your personal Google Sheet first') && exportSpreadsheetUrl.trim()) {
      setSubmitError(null);
    }
  }, [submitError, prompt, selectedTargets, googleSheetsConnected, exportSpreadsheetUrl]);

  return (
    <DashboardContext.Provider
      value={{
        runs,
        runsTotal,
        loadingRuns,
        runsError,
        lastUpdated,
        refreshRuns,
        setRunsError,
        runScopeMarket,
        runScopeLabel,
        runScopeKind,
        prompt,
        setPrompt,
        providers,
        scheduledAt,
        setScheduledAt,
        submitting,
        submitError,
        promptTemplates,
        selectedTemplateId,
        templateSearch,
        isLoading,
        selectedTargets,
        savedModelMixes,
        selectedModelMixId,
        promptRef,
        charCount,
        charOverLimit,
        charNearLimit,
        totalAvailableTargets,
        autoExportEnabled,
        setAutoExportEnabled,
        exportSpreadsheetUrl,
        setExportSpreadsheetUrl,
        exportSheetName,
        setExportSheetName,
        exportInvestmentAmount,
        setExportInvestmentAmount,
        exportTitle,
        setExportTitle,
        googleSheetsConnected,
        refreshGoogleSheetsStatus,
        handleSubmit,
        handlePromptChange,
        handleTemplateChange,
        handleTemplateSearch,
        toggleTarget,
        toggleAllForProvider,
        selectAllTargets,
        unselectAllTargets,
        applyModelMix,
        saveModelMix,
        renameModelMix,
        deleteModelMix,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}
