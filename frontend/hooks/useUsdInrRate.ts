'use client';

import { useEffect, useState } from 'react';

import { apiService } from '@/services/api';

export function useUsdInrRate() {
  const [usdInrRate, setUsdInrRate] = useState(0);

  useEffect(() => {
    let mounted = true;

    void apiService
      .getApiUsageSummary()
      .then((response) => {
        const nextRate = Number(response.usd_inr_rate);
        if (mounted && response.fx_status === 'valid' && nextRate > 0) {
          setUsdInrRate(nextRate);
        } else if (mounted) {
          setUsdInrRate(0);
        }
      })
      .catch(() => {
        if (mounted) setUsdInrRate(0);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return usdInrRate;
}
