import { useCallback, useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    load();

    const client = new WSClient({
      url: URLs.runs.ws(),
      onMessage: (data) => {
        if (data.type !== 'run.updated') return;
        const runId = data.run_id as number;
        const status = data.status as string;
        const currentStage = data.current_stage as number;
        setRuns((prev) =>
          prev.map((r) => (r.id === runId ? { ...r, status, current_stage: currentStage } : r)),
        );
        setLastUpdated(new Date());
      },
    });
    wsClientRef.current = client;
    client.connect();

    return () => {
      generationRef.current++;
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, [load]);

  return { runs, setRuns, total, setTotal, loading, error, setError, lastUpdated, refresh: load };
}
