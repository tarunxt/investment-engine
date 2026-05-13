import { useCallback, useEffect, useRef, useState } from 'react';
import { apiService, APIError } from '@/services/api';
import { JobResponse } from '@/types/api';
import { URLs } from '@/lib/urls';
import { WSClient } from '@/services/websocket';

function normalizeError(error: unknown): string {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

type JobUpdateMessage = {
  type: 'job.updated';
  job_id: number;
  status: string;
  response?: string | null;
  error_message?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
};

interface UseJobsOptions {
  limit: number;
  pollInterval?: number; // retained for API compatibility — no longer used
}

export interface UseJobsReturn {
  jobs: JobResponse[];
  setJobs: React.Dispatch<React.SetStateAction<JobResponse[]>>;
  total: number;
  setTotal: React.Dispatch<React.SetStateAction<number>>;
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  lastUpdated: Date | null;
  hasActiveJobs: boolean;
  wsConnected: boolean;
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
}

export function useJobs({ limit }: UseJobsOptions): UseJobsReturn {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // Incrementing generation discards stale HTTP responses without needing AbortSignal
  const generationRef = useRef(0);

  const hasActiveJobs = jobs.some((j) => ['pending', 'processing'].includes(j.status));

  // Stable ref so the WS message handler can call the latest load without going stale
  const loadRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const gen = ++generationRef.current;
      if (!silent) setLoading(true);
      try {
        const data = await apiService.getJobs({ page: 1, limit });
        if (gen !== generationRef.current) return;
        setJobs(data.items);
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

  // Keep ref current so the WS handler always calls the latest load
  loadRef.current = load;

  useEffect(() => {
    load();

    const client = new WSClient({
      url: URLs.jobs.ws(),
      onMessage: (data) => {
        if (data.type !== 'job.updated') return;
        const { type: _t, job_id, ...patch } = data as unknown as JobUpdateMessage;
        setJobs((prev) => {
          if (!prev.some((j) => j.id === job_id)) {
            // Job not in list (created after initial fetch) — reload to surface it
            setTimeout(() => void loadRef.current({ silent: true }), 0);
            return prev;
          }
          return prev.map((j) => (j.id === job_id ? { ...j, ...patch } : j));
        });
        setLastUpdated(new Date());
      },
      onStatusChange: setWsConnected,
    });
    client.connect();

    return () => {
      generationRef.current++;
      client.close();
    };
  }, [load]);

  return {
    jobs,
    setJobs,
    total,
    setTotal,
    loading,
    error,
    setError,
    lastUpdated,
    hasActiveJobs,
    wsConnected,
    refresh: load,
  };
}
