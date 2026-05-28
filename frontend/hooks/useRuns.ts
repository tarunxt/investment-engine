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
};

type RunJobUpdatedMessage = {
  type: 'job.updated';
  run_id: number;
  job_id: number;
  status?: string;
  response?: string | null;
  error_message?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
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
  });

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
                ? { ...run, status: message.status, current_stage: message.current_stage }
                : run,
            );
          });
        } else if (data.type === 'job.updated') {
          const message = data as unknown as RunJobUpdatedMessage;
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
                              updated_at: message.updated_at ?? runJob.job.updated_at,
                            },
                          }
                        : runJob,
                    ),
                  }
                : run,
            );
          });
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

  return { runs, setRuns, total, setTotal, loading, error, setError, lastUpdated, refresh: load };
}
