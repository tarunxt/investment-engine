import { useEffect, useState } from 'react';
import { apiService } from '@/services/api';
import { ProviderInfo } from '@/types/api';

export interface UseProvidersReturn {
  providers: ProviderInfo[];
  loading: boolean;
}

export function useProviders(): UseProvidersReturn {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiService
      .getProviders()
      .then((data) => {
        if (!cancelled) {
          setProviders(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { providers, loading };
}
