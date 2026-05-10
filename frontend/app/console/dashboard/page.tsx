'use client';

import { useEffect, useMemo, useState, type ElementType } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
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
import { JobResponse, PromptResponse, ProviderInfo } from '@/types/api';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { URLs } from '@/lib/urls';
import { useRouter } from 'next/navigation';

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

function formatTokens(value?: number | null) {
  return value?.toLocaleString() ?? '0';
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong';
}

export default function DashboardPage() {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [prompt, setPrompt] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptResponse[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  const router = useRouter();

  const models = providers.find((p) => p.name === provider)?.models ?? [];
  const hasActiveJobs = jobs.some((job) => ['pending', 'processing'].includes(job.status));

  const stats = useMemo(() => {
    const completed = jobs.filter((job) => job.status === 'completed').length;
    const active = jobs.filter((job) => ['pending', 'processing'].includes(job.status)).length;
    const failed = jobs.filter((job) => job.status === 'failed').length;
    return [
      { label: 'Total Jobs', value: jobs.length.toString(), icon: Sparkles },
      { label: 'Active', value: active.toString(), icon: Play },
      { label: 'Completed', value: completed.toString(), icon: CheckCircle2 },
      { label: 'Failed', value: failed.toString(), icon: AlertCircle },
    ];
  }, [jobs]);

  async function loadJobs({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) {
      setLoadingJobs(true);
    }

    try {
      const data = await apiService.getJobs();
      const sorted = [...data].sort((a, b) => b.id - a.id);
      setJobs(sorted);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      if (!silent) {
        setLoadingJobs(false);
      }
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      loadJobs();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    apiService.getProviders().then((data) => {
      setProviders(data);
      if (data.length > 0) {
        setProvider(data[0].name);
        setModel(data[0].models[0] ?? '');
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    apiService.getPrompts().then(setPromptTemplates).catch(() => { });
  }, []);

  function handleTemplateChange(id: string) {
    setSelectedTemplateId(id);
    const tpl = promptTemplates.find((p) => String(p.id) === id);
    if (tpl) setPrompt(tpl.body);
  }

  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }

    const interval = window.setInterval(() => {
      loadJobs({ silent: true });
    }, 5000);

    return () => window.clearInterval(interval);
  }, [hasActiveJobs]);

  function handleProviderChange(nextProvider: string) {
    setProvider(nextProvider);
    const info = providers.find((p) => p.name === nextProvider);
    setModel(info?.models[0] ?? '');
  }

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || !model) {
      setError('Prompt, provider, and model are required.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const job = await apiService.createJob({
        prompt: trimmedPrompt,
        provider,
        model,
      });
      setJobs((currentJobs) => [job, ...currentJobs]);
      setPrompt('');
      window.setTimeout(() => loadJobs({ silent: true }), 1200);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

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
          onClick={() => loadJobs()}
          disabled={loadingJobs}
          className="w-full sm:w-auto"
        >
          <RefreshCw className={cn('mr-2 size-4', loadingJobs && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                {stat.label}
              </span>
              <stat.icon className="size-4 text-gray-400" />
            </div>
            <div className="mt-3 text-2xl font-semibold text-gray-950">{stat.value}</div>
          </div>
        ))}
      </section>

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
                </div>

                <div className="space-y-2">
                  <Label htmlFor="model">Model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger id="model" className="w-full border-gray-300 px-3">
                      <SelectValue placeholder="Model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((modelName) => (
                        <SelectItem key={modelName} value={modelName}>
                          {modelName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {promptTemplates.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="template">Template</Label>
                  <Select value={selectedTemplateId} onValueChange={handleTemplateChange}>
                    <SelectTrigger id="template" className="w-full border-gray-300 px-3">
                      <SelectValue placeholder="Load a saved template…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem key="none" value="none">
                        None
                      </SelectItem>
                      {promptTemplates.map((tpl) => (
                        <SelectItem key={tpl.id} value={String(tpl.id)}>
                          {tpl.name}
                          <span className="ml-2 text-xs text-gray-400">v{tpl.version}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="prompt">Prompt</Label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setSelectedTemplateId('');
                  }}
                  rows={9}
                  className="w-full resize-none border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 shadow-sm outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10"
                  placeholder="Analyze Apple earnings quality, valuation risk, and near-term catalysts."
                />
              </div>

              <Button type="submit" disabled={submitting || !prompt.trim()} className="w-full">
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
                {' · '}
                <Link
                  href={URLs.routes.console.jobs()}
                  className="font-medium text-indigo-600 hover:text-indigo-800"
                >
                  View all →
                </Link>
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
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
                      Loading jobs
                    </td>
                  </tr>
                ) : jobs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
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
                        className={cn(
                          'align-top cursor-pointer hover:bg-gray-50',
                        )}
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
        </section>
      </div>
    </div>
  );
}
