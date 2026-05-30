'use client';

import { useEffect, useState } from 'react';

import { apiService } from '@/services/api';

const DEFAULT_USD_INR_RATE = 83.5;

export function useUsdInrRate() {
  const [usdInrRate, setUsdInrRate] = useState(DEFAULT_USD_INR_RATE);

  useEffect(() => {
    let mounted = true;

    void apiService
      .getApiUsageSummary()
      .then((response) => {
        const nextRate = Number(response.usd_inr_rate);
        if (mounted && nextRate > 0) {
          setUsdInrRate(nextRate);
        }
      })
      .catch(() => {
        // Keep the fallback rate when the usage summary is unavailable.
      });

    return () => {
      mounted = false;
    };
  }, []);

  return usdInrRate;
}
