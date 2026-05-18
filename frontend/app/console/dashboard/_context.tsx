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
import { apiService } from '@/services/api';
import { type PromptResponse, type ProviderInfo, type RunModelTarget, type RunResponse } from '@/types/api';
import { useRuns } from '@/hooks/useRuns';

export const DASHBOARD_RUN_LIMIT = 5;
export const TEMPLATE_DEBOUNCE_MS = 300;
export const PROMPT_MAX_CHARS = 3000;
export const PROMPT_WARN_CHARS = 2600;

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

interface DashboardContextValue {
  // Runs feed
  runs: RunResponse[];
  runsTotal: number;
  loadingRuns: boolean;
  runsError: string | null;
  lastUpdated: Date | null;
  refreshRuns: () => void;
  setRunsError: (error: string | null) => void;

  // Form state
  prompt: string;
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
  promptRef: React.RefObject<HTMLTextAreaElement>;

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
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
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

  const [prompt, setPrompt] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptResponse[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  const templateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const templateControllerRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null!);

  const initDashboard = useCallback(async () => {
    setIsLoading(true);
    const controller = new AbortController();

    const [providersRes, templatesRes] = await Promise.allSettled([
      apiService.getProviders({ signal: controller.signal }),
      apiService.getPrompts({ q: '' }, controller.signal),
    ]);

    if (providersRes.status === 'fulfilled') {
      const data = providersRes.value as ProviderInfo[];
      setProviders(data);
      setSelectedTargets(
        new Set(data.flatMap((p) => p.models.map((m) => `${p.name}::${m}`))),
      );
    } else if (providersRes.reason?.name !== 'AbortError') {
      console.error('Failed to load providers:', providersRes.reason);
    }

    if (templatesRes.status === 'fulfilled') {
      setPromptTemplates(templatesRes.value);
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    initDashboard();
    return () => templateControllerRef.current?.abort('Cleanup');
  }, []);

  const fetchTemplates = useCallback(async (q: string) => {
    templateControllerRef.current?.abort('New search started');
    const controller = new AbortController();
    templateControllerRef.current = controller;
    try {
      const data = await apiService.getPrompts({ q: q.trim() || undefined }, controller.signal);
      setPromptTemplates(data);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
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
    setSelectedTemplateId('');
  }, []);

  const handleTemplateChange = useCallback(
    (id: string) => {
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
      const keys = providerModels.map((m) => `${providerName}::${m}`);
      const allChecked = keys.every((k) => selectedTargets.has(k));
      setSelectedTargets((prev) => {
        const next = new Set(prev);
        if (allChecked) keys.forEach((k) => next.delete(k));
        else keys.forEach((k) => next.add(k));
        return next;
      });
    },
    [selectedTargets],
  );

  const parseTargets = (): RunModelTarget[] =>
    Array.from(selectedTargets).map((key) => {
      const [p, m] = key.split('::');
      return { provider: p, model: m };
    });

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
      setSubmitting(true);
      setSubmitError(null);
      try {
        const run = await apiService.createRun({
          prompt: trimmedPrompt,
          targets,
          scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        });
        setPrompt('');
        setScheduledAt('');
        setSelectedTemplateId('');
        promptRef.current?.focus();
        // Prepend the new run as a single entry — one row per job submission
        setRuns((current) => [run, ...current].slice(0, DASHBOARD_RUN_LIMIT));
        setRunsTotal((t) => t + 1);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to create job');
      } finally {
        setSubmitting(false);
      }
    },
    [prompt, selectedTargets, scheduledAt],
  );

  const charCount = prompt.length;
  const charOverLimit = charCount > PROMPT_MAX_CHARS;
  const charNearLimit = charCount > PROMPT_WARN_CHARS && !charOverLimit;
  const totalAvailableTargets = providers.reduce((n, p) => n + p.models.length, 0);

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
        prompt,
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
        promptRef,
        charCount,
        charOverLimit,
        charNearLimit,
        totalAvailableTargets,
        handleSubmit,
        handlePromptChange,
        handleTemplateChange,
        handleTemplateSearch,
        toggleTarget,
        toggleAllForProvider,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}
