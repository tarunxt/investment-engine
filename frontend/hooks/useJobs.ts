import { useCallback, useEffect, useRef, useState } from 'react';
import { apiService, APIError } from '@/services/api';
import { JobResponse } from '@/types/api';

function normalizeError(error: unknown): string {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

interface UseJobsOptions {
  limit: number;
  pollInterval?: number;
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
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
}

export function useJobs({ limit, pollInterval = 5000 }: UseJobsOptions): UseJobsReturn {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Incrementing generation discards stale responses without needing AbortSignal on getJobs
  const generationRef = useRef(0);

  const hasActiveJobs = jobs.some((j) => ['pending', 'processing'].includes(j.status));

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const gen = ++generationRef.current;
      if (!silent) setLoading(true);
      try {
        const data = await apiService.getJobs({ page: 1, page_size: limit });
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

  useEffect(() => {
    load();
    return () => { generationRef.current++; };
  }, [load]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = window.setInterval(() => load({ silent: true }), pollInterval);
    return () => window.clearInterval(interval);
  }, [hasActiveJobs, load, pollInterval]);

  return { jobs, setJobs, total, setTotal, loading, error, setError, lastUpdated, hasActiveJobs, refresh: load };
}
