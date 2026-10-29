'use client';

import { use, useEffect, useRef, useState, type ElementType } from 'react';
import { useRouter } from 'next/navigation';
import {useSession} from 'next-auth/react';
import {useWorkspaceDisplay} from '@/components/workspace/WorkspaceDisplay';
import {ConceptFSavedText} from '@/components/workspace/ConceptFSavedText';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import { JobResponse } from '@/types/api';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { WSClient } from '@/services/websocket';
import InvestmentRecommendationTable from '@/components/InvestmentRecommendationTable';
import { OutputConsistencyNotice } from '@/components/OutputConsistencyNotice';
import ExportToSheetsModal from './_components/ExportToSheetsModal';

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

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const {data:session,status:sessionStatus}=useSession();
  const display=useWorkspaceDisplay(),uat2=process.env.NEXT_PUBLIC_UAT2==='true',masked=display?.value.masked??true;
  const scope=`${sessionStatus}:${session?.user?.id}:${session?.generation}:${id}`;
  const [jobScope,setJobScope]=useState('');
  const [job, setJob] = useState<JobResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const isActive = job && !TERMINAL_STATUSES.has(job.status);
  const readController = useRef<AbortController | null>(null);
  const ownerId = session?.user?.id;

  function loadJob() {
    readController.current?.abort();
    setLoading(true);
    setJob(null);
    setError(null);
    setRevision(value => value + 1);
  }

  useEffect(() => {
    if (uat2 && (sessionStatus !== 'authenticated' || !ownerId)) return;
    let active = true;
    const controller = new AbortController();
    readController.current = controller;
    async function readJob() {
      try {
        if (uat2 && !/^[1-9][0-9]{0,12}$/.test(String(id))) {
          throw new Error('Exact job identity required');
        }
        const data = uat2
          ? await apiService.get<JobResponse>(URLs.jobs.get(Number(id)), {
              signal: controller.signal, cache: "no-store", timeoutMs: 8000,
            })
          : await apiService.getJob(Number(id));
        if (!active || controller.signal.aborted) return;
        if (uat2 && (!data || data.id !== Number(id) || typeof data.prompt !== 'string' ||
          typeof data.provider !== 'string' || typeof data.model !== 'string' || typeof data.status !== 'string' ||
          data.response !== null && data.response !== undefined && typeof data.response !== 'string' ||
          data.error_message !== null && data.error_message !== undefined && typeof data.error_message !== 'string')) {
          throw new Error('Exact saved job response required');
        }
        setJob(data);
        setJobScope(scope);
        setError(null);
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setError(uat2 ? 'Requested saved job could not be verified. No other record or successful outcome is inferred.' : normalizeError(err));
        setJobScope(scope);
      } finally {
        if (active && !controller.signal.aborted) setLoading(false);
      }
    }
    void readJob();
    // Native UAT2 mounts owned GETs, not the legacy job WebSocket relay.
    // A read must not mint a ticket or require Redis merely to view history.
    return () => { active = false; controller.abort(); };
  }, [id, uat2, scope, sessionStatus, ownerId, revision]);

  useEffect(() => {
    if (uat2) return;
    let active = true;
    const client = new WSClient({
      url: URLs.jobs.wsJob(Number(id)),
      onMessage: (data) => {
        if (!active || data.type !== 'job.updated') return;
        const { ...patch } = data as { type: string; job_id: number; [key: string]: unknown };
        setJob((prev) => (prev ? { ...prev, ...patch } : prev));
        const newStatus = patch.status as string | undefined;
        if (newStatus && TERMINAL_STATUSES.has(newStatus)) client.close();
      },
    });
    client.connect();
    return () => {
      active = false;
      client.close();
    };
  }, [id, uat2]);

  if (loading||uat2&&jobScope!==scope) {
    return (
      <div data-uat2-recorded-job={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <Loader2 className="size-4 animate-spin" />
          Loading job…
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div data-uat2-recorded-job={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error ?? 'Job not found.'}</span>
        </div>
      </div>
    );
  }

  const StatusIcon = STATUS_ICONS[job.status] ?? Clock3;
  const hasResponse = Boolean(job.response?.trim());

  return (
    <div data-uat2-recorded-job={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant={'ghost'}
            onClick={() => router.back()}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <span className="text-gray-300">/</span>
          <h1 className="text-lg font-semibold tracking-tight text-gray-950">Job #{job.id}</h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
              STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
            )}
          >
            <StatusIcon className={cn('size-3.5', job.status === 'processing' && 'animate-spin')} />
            {job.status}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => loadJob()}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          {job.status === 'completed' && (
            <ExportToSheetsModal job={job} />
          )}
        </div>
      </div>

      {uat2&&<p role="status" className="rounded border p-3 text-sm">Saved job record only. Use Refresh to read its current recorded state. This UAT2 view does not subscribe to a live job stream or authorize a provider call.</p>}
      {isActive && !uat2 && (
        <div className="flex items-center gap-2 border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-700">
          <span className="inline-block size-1.5 rounded-full bg-blue-500" />
          Live — updates will appear automatically.
        </div>
      )}

      <div className="grid gap-4">
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Provider
          </div>
          <div className="mt-2 font-medium capitalize text-gray-950">{job.provider}</div>
          <div className="mt-0.5 text-xs text-gray-500">{job.model}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-1">
        <div className="border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 px-5 py-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Prompt
            </span>
          </div>
          <div className="p-5">
            <>{uat2?<ConceptFSavedText value={job.prompt} label={`Job ${job.id} prompt`} masked={masked}/>:<p className="whitespace-pre-wrap text-sm leading-6 text-gray-800">{job.prompt.slice(0, 100)}...</p>}</>
          </div>
        </div>

        <div className="border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 px-5 py-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Response
            </span>
          </div>

          <div className="p-5 max-w-full">
            {(!uat2||!masked)&&<OutputConsistencyNotice metadata={job.runtime_metadata_json} />}
            {job.status === 'failed' && job.error_message ? (
              <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <>{uat2?<ConceptFSavedText value={job.error_message} label={`Job ${job.id} saved error`} masked={masked}/>:<p className="whitespace-pre-wrap leading-6">{job.error_message}</p>}</>
              </div>
            ) : null}

            {hasResponse ? (
              <>{uat2&&masked?<p>Saved output is masked. Reveal deliberately in Profile before inspecting it.</p>:<><InvestmentRecommendationTable content={job.response ?? ''} provider={job.provider} model={job.model}/>{uat2&&<details className="mt-4"><summary className="min-h-11 cursor-pointer">Full saved output · inert text</summary><ConceptFSavedText value={job.response} label={`Job ${job.id} output`} masked={false}/></details>}</>}</>
            ) : job.status === 'failed' && job.error_message ? null : (
              <p className="text-sm italic text-gray-400">
                {uat2?'No saved response supplied. No successful empty result or current provider state is inferred.':isActive ? 'Response pending…' : 'No response.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
