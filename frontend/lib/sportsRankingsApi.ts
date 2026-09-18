const base = '/backend-api/api/sports-rankings';
const transientStatuses = new Set([500, 502, 503, 504]);

export type RankingErrorDetails = {
  title: string;
  summary: string;
  cause: string;
  steps: string[];
  status: number | null;
  code: string;
  endpoint: string;
  correlationId: string | null;
  retryAfter: string | null;
  proxyBudgetMs: number | null;
  occurredAt: string;
  attempts: number;
  serviceMessage: string | null;
};

export class RankingReadError extends Error {
  readonly details: RankingErrorDetails;

  constructor(message: string, details: RankingErrorDetails) {
    super(message);
    this.name = 'RankingReadError';
    this.details = details;
  }
}

function defaultSteps(status: number | null) {
  if (status === 401) return [
    'Sign in again, then return to Sports Rankings.',
    'If the page still reports an expired session, sign out fully and sign back in.',
  ];
  if (status === 403) return [
    'Confirm that this account is allowed to open the rankings repository.',
    'Ask an administrator to restore the required console permission if access was removed.',
  ];
  return [
    'Wait for the automatic retry, or use Retry now to start a fresh request.',
    'If it repeats, check Run History for a long-running or stale scan and let that run finish or recover.',
    'If other console pages also time out, verify backend and database health; an operator should restart the unhealthy service only after checking the active run.',
    'Give support the correlation ID and occurrence time shown below so the matching server log can be found.',
  ];
}

async function responseFailure(response: Response, path: string, attempts: number) {
  let payload: { error?: unknown; message?: unknown; detail?: unknown } = {};
  try { payload = await response.clone().json(); } catch { /* Response was not JSON. */ }
  const status = response.status;
  const code = typeof payload.error === 'string' ? payload.error :
    status === 504 ? 'BACKEND_TIMEOUT' : status === 503 ? 'SERVICE_UNAVAILABLE' :
    status === 502 ? 'BACKEND_UNREACHABLE' : status === 401 ? 'AUTHENTICATION_REQUIRED' :
    status === 403 ? 'ACCESS_DENIED' : `HTTP_${status}`;
  const serviceMessage = [payload.message, payload.detail].find(value => typeof value === 'string') as string | undefined;
  const proxyBudget = Number(response.headers.get('x-backend-proxy-budget-ms'));
  const cause = status === 504
    ? 'The Cred-X proxy reached its backend response deadline before the rankings API completed. This is a service/database availability problem, not a missing UEL ranking or an invalid search.'
    : status === 503
      ? code === 'DATABASE_UNAVAILABLE'
        ? 'The rankings API could not obtain a healthy database connection.'
        : 'The rankings service reported that it is temporarily unavailable.'
      : status === 502
        ? 'The Cred-X proxy could not reach a healthy backend API instance.'
      : status === 401
        ? 'The backend could not validate the current login session.'
      : status === 403
        ? 'The current account is authenticated but does not have access to this request.'
      : 'The rankings API returned an unexpected server response.';
  const message = status === 401 ? 'Please sign in to view rankings.' :
    transientStatuses.has(status) ? 'Rankings are temporarily unavailable. Automatic retries will continue; you can also retry now.' :
    `Unable to load rankings (${status}). Please retry.`;
  return new RankingReadError(message, {
    title: status === 504 ? 'Rankings request timed out' : status === 401 ? 'Sign-in required' : 'Rankings request failed',
    summary: message,
    cause,
    steps: defaultSteps(status),
    status,
    code,
    endpoint: `${base}${path}`,
    correlationId: response.headers.get('x-correlation-id'),
    retryAfter: response.headers.get('retry-after'),
    proxyBudgetMs: Number.isFinite(proxyBudget) && proxyBudget > 0 ? proxyBudget : null,
    occurredAt: new Date().toISOString(),
    attempts,
    serviceMessage: serviceMessage ?? null,
  });
}

function connectionFailure(path: string, attempts: number) {
  return new RankingReadError('The rankings connection timed out. Automatic retries will continue.', {
    title: 'Rankings connection failed',
    summary: 'The rankings connection timed out. Automatic retries will continue.',
    cause: 'The browser did not receive a response from the Cred-X rankings endpoint before its connection deadline.',
    steps: defaultSteps(null),
    status: null,
    code: 'NETWORK_OR_CLIENT_TIMEOUT',
    endpoint: `${base}${path}`,
    correlationId: null,
    retryAfter: null,
    proxyBudgetMs: null,
    occurredAt: new Date().toISOString(),
    attempts,
    serviceMessage: null,
  });
}

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
      // The authenticated proxy allows one slow database-backed ranking read
      // to finish before falling back to another origin.
      const timeout = AbortSignal.timeout(16_500);
      const response = await fetcher(base + path, {
        cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) return await response.json();
      const failure = await responseFailure(response, path, attempt + 1);
      if (!transientStatuses.has(response.status) || attempt === 2) throw failure;
    } catch (error) {
      signal?.throwIfAborted();
      // Network/timeout failures are transient. Application/auth errors are not.
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
      if (attempt === 2) throw connectionFailure(path, attempt + 1);
    }
    await delay(1500 * (attempt + 1), signal);
  }
  throw new Error('Unable to load rankings.');
}

export async function readSportsEventComparisons<T>(
  events: Array<{ market_id: string; event_slug?: string | null; event_title?: string | null }>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/bullpen-ai/sports-event-comparisons', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (response.status === 401) throw new Error('Please sign in to view rankings.');
  if (!response.ok) throw new Error(`Unable to load event rankings (${response.status}).`);
  return response.json() as Promise<T>;
}
