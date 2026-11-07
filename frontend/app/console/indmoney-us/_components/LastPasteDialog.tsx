'use client';

import { useEffect, useState } from 'react';
import { BasketModalLayer } from '@/components/BasketMetricPopup';
import styles from '@/components/BasketMetricPopup.module.css';
import { formatPortfolioTimestamp } from '@/lib/portfolioTimestamp';
import { URLs } from '@/lib/urls';
import { apiService } from '@/services/api';

type LastPaste = { pasted_at: string; raw_text: string };

export function LastPasteDialog({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<LastPaste | null>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    apiService.get<LastPaste | null>(`${URLs.indmoneyUs.portfolio()}/last-paste`, { cache: 'no-store' })
      .then(value => { if (active) setSnapshot(value); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  return <BasketModalLayer title="Last pasted snapshot" wide onClose={onClose}
    eyebrow={snapshot ? `Pasted · ${formatPortfolioTimestamp(snapshot.pasted_at)}` : 'INDmoney US'}
    footer={<button type="button" className={styles.button} onClick={onClose}>Done</button>}>
    {snapshot ? <pre className="whitespace-pre-wrap break-words rounded-xl bg-[var(--metric-tile)] p-4 text-sm leading-relaxed">{snapshot.raw_text}</pre>
      : <p role={error ? 'alert' : 'status'}>{error ? 'Could not load the last paste. Close and reopen to retry.' : snapshot === null ? 'No saved paste yet.' : 'Loading last paste…'}</p>}
  </BasketModalLayer>;
}
