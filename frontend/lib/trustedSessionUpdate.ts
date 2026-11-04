import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

type Replacement = { accessToken: string; refreshToken: string; expiresIn: number };
type TrustedUpdate = { subject: string; generation: string; previousRefreshToken: string; replacement: Replacement };
const scope = new AsyncLocalStorage<TrustedUpdate>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function sessionGeneration(token: Record<string, unknown>): string {
  return typeof token.sessionGeneration === 'string' ? token.sessionGeneration : `${String(token.sub || '')}:${String(token.iat || '')}`;
}

export function withTrustedSessionUpdate<T>(update: TrustedUpdate, action: () => T): T {
  return scope.run(update, action);
}

/** Browser update fields never authorize credential or account replacement. */
export function trustedSessionReplacement(token: Record<string, unknown>): Replacement | null {
  const update = scope.getStore();
  if (!update || String(token.id || token.sub || '') !== update.subject || sessionGeneration(token) !== update.generation
      || typeof token.refreshToken !== 'string') return null;
  const current = digest(token.refreshToken);
  if (current !== digest(update.previousRefreshToken) && current !== digest(update.replacement.refreshToken)) return null;
  return update.replacement;
}
