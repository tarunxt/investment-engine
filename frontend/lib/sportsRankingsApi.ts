const base = '/backend-api/api/sports-rankings';
const transientStatuses = new Set([500, 502, 503, 504]);

async function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Retry only safe reads; never resubmit a manual refresh or other mutation. */
export async function readRankingJson<T>(
  path: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  delay: typeof pause = pause,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(8000);
      const response = await fetcher(base + path, {
        cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) return await response.json();
      if (response.status === 401) throw new Error('Please sign in to view rankings.');
      if (!transientStatuses.has(response.status)) throw new Error(`Unable to load rankings (${response.status}). Please retry.`);
      if (attempt === 2) throw new Error('Rankings are temporarily unavailable. Automatic retries will continue; you can also retry now.');
    } catch (error) {
      signal?.throwIfAborted();
      // Network/timeout failures are transient. Application/auth errors are not.
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
      if (attempt === 2) throw new Error('The rankings connection timed out. Automatic retries will continue.');
    }
    await delay(1500 * (attempt + 1), signal);
  }
  throw new Error('Unable to load rankings.');
}
