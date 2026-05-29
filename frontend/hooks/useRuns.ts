import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiService, APIError } from '@/services/api';
import { WSClient } from '@/services/websocket';
import { URLs } from '@/lib/urls';
import { RunResponse } from '@/types/api';

function normalizeError(error: unknown): string {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

interface UseRunsOptions {
  limit: number;
}

type RunUpdatedMessage = {
  type: 'run.updated';
  run_id: number;
  status: string;
  current_stage: number;
  export_status?: string | null;
  export_error?: string | null;
  exported_at?: string | null;
  exported_sheet_url?: string | null;
};

type RunJobUpdatedMessage = {
  type: 'job.updated';
  run_id: number;
  job_id: number;
  provider?: string;
  model?: string;
  status?: string;
  response?: string | null;
  error_message?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  export_status?: string | null;
  export_error?: string | null;
  exported_at?: string | null;
  exported_sheet_url?: string | null;
  updated_at?: string;
};

export interface UseRunsReturn {
  runs: RunResponse[];
  setRuns: React.Dispatch<React.SetStateAction<RunResponse[]>>;
  total: number;
  setTotal: React.Dispatch<React.SetStateAction<number>>;
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  lastUpdated: Date | null;
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
}

export function useRuns({ limit }: UseRunsOptions): UseRunsReturn {
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const generationRef = useRef(0);
  const wsClientRef = useRef<WSClient | null>(null);
  const loadRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});
  const runsRef = useRef<RunResponse[]>([]);
  const notifiedRef = useRef<Set<string>>(new Set());

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const gen = ++generationRef.current;
      if (!silent) setLoading(true);
      try {
        const data = await apiService.getRuns({ page: 1, limit });
        if (gen !== generationRef.current) return;
        setRuns(data.items);
        setTotal(data.total);
        setLastUpdated(new Date());
        setError(null);
      } catch (err) {
        if (gen !== generationRef.current) return;
        setError(normalizeError(err));
      } finally {
        if (gen === generationRef.current && !silent) setLoading(false);
      }
    },
    [limit],
  );

  useLayoutEffect(() => {
    loadRef.current = load;
    runsRef.current = runs;
  });

  const maybeNotify = useCallback((runId: number, jobId: number, provider: string, model: string, status: string) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const key = `${jobId}:${status}`;
    if (notifiedRef.current.has(key)) return;
    notifiedRef.current.add(key);
    const title = status === 'completed' ? 'Model Completed' : 'Model Failed';
    const body = `${provider}/${model} for Run #${runId} is ${status}.`;
    try {
      new Notification(title, { body });
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();

    const client = new WSClient({
      url: URLs.runs.ws(),
      onMessage: (data) => {
        if (data.type === 'run.updated') {
          const message = data as unknown as RunUpdatedMessage;
          setRuns((prev) => {
            if (!prev.some((run) => run.id === message.run_id)) {
              setTimeout(() => void loadRef.current({ silent: true }), 0);
              return prev;
            }
            return prev.map((run) =>
              run.id === message.run_id
                ? {
                    ...run,
                    status: message.status,
                    current_stage: message.current_stage,
                    export_status: message.export_status ?? run.export_status,
                    export_error: message.export_error ?? run.export_error,
                    exported_at: message.exported_at ?? run.exported_at,
                    exported_sheet_url: message.exported_sheet_url ?? run.exported_sheet_url,
                  }
                : run,
            );
          });
        } else if (data.type === 'job.updated') {
          const message = data as unknown as RunJobUpdatedMessage;
          const priorRun = runsRef.current.find((run) => run.id === message.run_id);
          const priorRunJob = priorRun?.run_jobs.find((runJob) => runJob.job.id === message.job_id);
          const priorStatus = priorRunJob?.job.status;
          setRuns((prev) => {
            if (!prev.some((run) => run.id === message.run_id)) {
              setTimeout(() => void loadRef.current({ silent: true }), 0);
              return prev;
            }
            return prev.map((run) =>
              run.id === message.run_id
                ? {
                    ...run,
                    run_jobs: run.run_jobs.map((runJob) =>
                      runJob.job.id === message.job_id
                        ? {
                            ...runJob,
                            job: {
                              ...runJob.job,
                              status: message.status ?? runJob.job.status,
                              response: message.response ?? runJob.job.response,
                              error_message: message.error_message ?? runJob.job.error_message,
                              tokens_in: message.tokens_in ?? runJob.job.tokens_in,
                              tokens_out: message.tokens_out ?? runJob.job.tokens_out,
                              estimated_cost: message.estimated_cost ?? runJob.job.estimated_cost,
                              export_status: message.export_status ?? runJob.job.export_status,
                              export_error: message.export_error ?? runJob.job.export_error,
                              exported_at: message.exported_at ?? runJob.job.exported_at,
                              exported_sheet_url: message.exported_sheet_url ?? runJob.job.exported_sheet_url,
                              updated_at: message.updated_at ?? runJob.job.updated_at,
                            },
                          }
                        : runJob,
                    ),
                  }
                : run,
            );
          });
          const nextStatus = message.status ?? priorStatus;
          if ((nextStatus === 'completed' || nextStatus === 'failed') && nextStatus !== priorStatus) {
            maybeNotify(
              message.run_id,
              message.job_id,
              message.provider ?? priorRunJob?.job.provider ?? 'model',
              message.model ?? priorRunJob?.job.model ?? '',
              nextStatus,
            );
          }
        } else {
          return;
        }
        setLastUpdated(new Date());
      },
    });
    wsClientRef.current = client;
    client.connect();

    return () => {
      generationRef.current += 1;
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const hasActive = runs.some((run) => {
      const runStatus = (run.status || '').toLowerCase();
      if (runStatus === 'pending' || runStatus === 'processing' || runStatus === 'scheduled') return true;
      const exportStatus = (run.export_status || '').toLowerCase();
      return exportStatus === 'queued' || exportStatus === 'processing' || exportStatus === 'pending' || exportStatus === 'partial';
    });
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void loadRef.current({ silent: true });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [runs]);

  return { runs, setRuns, total, setTotal, loading, error, setError, lastUpdated, refresh: load };
}
