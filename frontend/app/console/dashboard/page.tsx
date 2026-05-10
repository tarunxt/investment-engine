'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ElementType } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Send,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiService, APIError } from '@/services/api';
import { JobResponse, PromptResponse } from '@/types/api';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { URLs } from '@/lib/urls';
import { useRouter } from 'next/navigation';
import { useJobs } from '@/hooks/useJobs';
import { useProviders } from '@/hooks/useProviders';

const DASHBOARD_JOB_LIMIT = 5;
const POLL_INTERVAL_MS = 5000;
const TEMPLATE_DEBOUNCE_MS = 300;
const PROMPT_REFRESH_DELAY_MS = 1200;
const PROMPT_MAX_CHARS = 3000;
const PROMPT_WARN_CHARS = 2600;

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
};

const STATUS_ICONS: Record<string, ElementType> = {
  pending: Clock3,
  processing: Loader2,
  completed: CheckCircle2,
  failed: AlertCircle,
};

function normalizeError(error: unknown): string {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function SelectSkeleton() {
  return <div className="h-9 w-full animate-pulse rounded border border-gray-200 bg-gray-100" />;
}

export default function DashboardPage() {
  const router = useRouter();

  const {
    jobs,
    setJobs,
    total: jobsTotal,
    setTotal: setJobsTotal,
    loading: loadingJobs,
    error: jobsError,
    setError: setJobsError,
    lastUpdated,
    hasActiveJobs,
    refresh: refreshJobs,
  } = useJobs({ limit: DASHBOARD_JOB_LIMIT, pollInterval: POLL_INTERVAL_MS });

  const { providers, loading: loadingProviders } = useProviders();

  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptResponse[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');

  const templateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const templateControllerRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const models = providers.find((p) => p.name === provider)?.models ?? [];

  // Set initial provider/model once providers load
  useEffect(() => {
    if (providers.length > 0 && !provider) {
      setProvider(providers[0].name);
      setModel(providers[0].models[0] ?? '');
    }
  }, [providers, provider]);

  const fetchTemplates = useCallback(async (q: string) => {
    templateControllerRef.current?.abort();
    const controller = new AbortController();
    templateControllerRef.current = controller;
    try {
      const data = await apiService.getPrompts({ q: q.trim() || undefined }, controller.signal);
      if (!controller.signal.aborted) setPromptTemplates(data);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }, []);

  // Initial template load; cleanup aborts any in-flight request on unmount
  useEffect(() => {
    fetchTemplates('');
    return () => {
      templateControllerRef.current?.abort();
      if (templateDebounceRef.current) clearTimeout(templateDebounceRef.current);
    };
  }, [fetchTemplates]);

  const handleTemplateSearch = useCallback(
    (q: string) => {
      setTemplateSearch(q);
      if (templateDebounceRef.current) clearTimeout(templateDebounceRef.current);
      templateDebounceRef.current = setTimeout(() => fetchTemplates(q), TEMPLATE_DEBOUNCE_MS);
    },
    [fetchTemplates],
  );

  const handleTemplateChange = useCallback(
    (id: string) => {
      setSelectedTemplateId(id);
      const tpl = promptTemplates.find((p) => String(p.id) === id);
      if (tpl) setPrompt(tpl.body);
    },
    [promptTemplates],
  );

  const handleProviderChange = useCallback(
    (nextProvider: string) => {
      setProvider(nextProvider);
      const info = providers.find((p) => p.name === nextProvider);
      setModel(info?.models[0] ?? '');
    },
    [providers],
  );

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    setSelectedTemplateId('');
  }, []);

  const handleSubmit = useCallback(
    async (event: { preventDefault(): void }) => {
      event.preventDefault();
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || !model) {
        setSubmitError('Prompt, provider, and model are required.');
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const job = await apiService.createJob({ prompt: trimmedPrompt, provider, model });
        setJobs((current) => [job, ...current.slice(0, DASHBOARD_JOB_LIMIT - 1)]);
        setJobsTotal((t) => t + 1);
        setPrompt('');
        setSelectedTemplateId('');
        promptRef.current?.focus();
        window.setTimeout(() => refreshJobs({ silent: true }), PROMPT_REFRESH_DELAY_MS);
      } catch (err) {
        setSubmitError(normalizeError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [prompt, model, provider, setJobs, setJobsTotal, refreshJobs],
  );

  const charCount = prompt.length;
  const charOverLimit = charCount > PROMPT_MAX_CHARS;
  const charNearLimit = charCount > PROMPT_WARN_CHARS;

  return (
    <div className="mx-auto flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">AI Job Console</h1>
          <p className="mt-1 text-sm text-gray-600">
            Queue investment research jobs and monitor worker execution.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => refreshJobs()}
          disabled={loadingJobs}
          className="w-full sm:w-auto"
        >
          <RefreshCw className={cn('mr-2 size-4', loadingJobs && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {jobsError && (
        <div className="flex items-start justify-between gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{jobsError}</span>
          </div>
          <button
            onClick={() => { setJobsError(null); refreshJobs(); }}
            className="shrink-0 text-xs font-semibold underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(320px,520px)_1fr]">
        <Card className="border border-gray-200 shadow-sm" size="sm">
          <CardHeader>
            <CardTitle>Create Job</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                <div className="space-y-2">
                  <Label htmlFor="provider">Provider</Label>
                  {loadingProviders ? (
                    <SelectSkeleton />
                  ) : (
                    <Select value={provider} onValueChange={handleProviderChange}>
                      <SelectTrigger id="provider" className="w-full border-gray-300 px-3">
                        <SelectValue placeholder="Provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {p.name.charAt(0).toUpperCase() + p.name.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="model">Model</Label>
                  {loadingProviders ? (
                    <SelectSkeleton />
                  ) : (
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger id="model" className="w-full border-gray-300 px-3">
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="template-search">Template</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" />
                  <input
                    id="template-search"
                    type="text"
                    value={templateSearch}
                    onChange={(e) => handleTemplateSearch(e.target.value)}
                    placeholder="Search prompts…"
                    className="w-full border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-950 outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10"
                  />
                </div>
                {promptTemplates.length > 0 ? (
                  <Select value={selectedTemplateId} onValueChange={handleTemplateChange}>
                    <SelectTrigger id="template" className="w-full border-gray-300 px-3">
                      <SelectValue placeholder="Load a saved template…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {promptTemplates.map((tpl) => (
                        <SelectItem key={tpl.id} value={String(tpl.id)}>
                          {tpl.name}
                          <span className="ml-2 text-xs text-gray-400">v{tpl.version}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : templateSearch ? (
                  <p className="text-xs text-gray-400">
                    No prompts match &ldquo;{templateSearch}&rdquo;
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="prompt">Prompt</Label>
                  <span
                    className={cn(
                      'text-xs tabular-nums',
                      charOverLimit
                        ? 'font-semibold text-red-600'
                        : charNearLimit
                          ? 'text-amber-600'
                          : 'text-gray-400',
                    )}
                  >
                    {charCount}/{PROMPT_MAX_CHARS}
                  </span>
                </div>
                <textarea
                  id="prompt"
                  ref={promptRef}
                  value={prompt}
                  onChange={handlePromptChange}
                  rows={9}
                  className={cn(
                    'w-full resize-none border bg-white px-3 py-2 text-sm text-gray-950 shadow-sm outline-none transition focus:ring-2 focus:ring-gray-950/10',
                    charOverLimit
                      ? 'border-red-400 focus:border-red-500'
                      : 'border-gray-300 focus:border-gray-950',
                  )}
                  placeholder="Analyze Apple earnings quality, valuation risk, and near-term catalysts."
                />
              </div>

              {submitError && (
                <p className="text-sm text-red-700">{submitError}</p>
              )}

              <Button
                type="submit"
                disabled={submitting || !prompt.trim() || charOverLimit}
                className="w-full"
              >
                {submitting ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Send className="mr-2 size-4" />
                )}
                Submit Job
              </Button>
            </form>
          </CardContent>
        </Card>

        <section className="min-w-0 border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-1 border-b border-gray-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-950">
                Recent Jobs
              </h2>
              <p className="text-xs text-gray-500">
                {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Waiting for data'}
              </p>
            </div>
            {hasActiveJobs && (
              <div className="inline-flex items-center gap-2 text-xs font-medium text-blue-700">
                <Loader2 className="size-3.5 animate-spin" />
                Polling active jobs
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Job
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Provider
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {loadingJobs ? (
                  <tr>
                    <td colSpan={3} className="px-5 py-10 text-center text-sm text-gray-500">
                      <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
                      Loading jobs…
                    </td>
                  </tr>
                ) : jobs.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-5 py-10 text-center text-sm text-gray-500">
                      No jobs yet
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => {
                    const StatusIcon = STATUS_ICONS[job.status] ?? Clock3;
                    return (
                      <tr
                        key={job.id}
                        onClick={() => router.push(URLs.routes.console.jobDetail(job.id))}
                        className="cursor-pointer align-top hover:bg-gray-50"
                      >
                        <td className="max-w-90 px-5 py-4">
                          <div className="font-medium text-gray-950">#{job.id}</div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-600">
                            {job.prompt}
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <div className="font-medium capitalize text-gray-950">{job.provider}</div>
                          <div className="mt-1 text-xs text-gray-500">{job.model}</div>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
                              STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                            )}
                          >
                            <StatusIcon
                              className={cn(
                                'size-3.5',
                                job.status === 'processing' && 'animate-spin',
                              )}
                            />
                            {job.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3">
            <span className="text-xs text-gray-500">
              {jobsTotal === 0
                ? 'No jobs yet'
                : `Showing ${jobs.length} of ${jobsTotal} job${jobsTotal !== 1 ? 's' : ''}`}
            </span>
            <Link
              href={URLs.routes.console.jobs()}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              View all →
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
