/** Explicit private storage facade: owner + existing resource key, no legacy reads.
 * Owner is document-scoped. Identity changes reload the private document so old
 * callbacks can never write into a newly adopted account's namespace.
 */
export const PRIVATE_STORAGE_PREFIX = "investment-engine:private:v1:";
let owner: string | null = null;

export function setPrivateStorageOwner(userId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId < 1) return false;
  const next = String(userId);
  if (owner !== null && owner !== next) return false;
  owner = next;
  return true;
}

export function clearPrivateStorageOwner() { owner = null; }

function storage(kind: "localStorage" | "sessionStorage") {
  return typeof window === "undefined" ? null : window[kind];
}

function facade(kind: "localStorage" | "sessionStorage"): Storage {
  const prefix = () => owner === null ? null : `${PRIVATE_STORAGE_PREFIX}${owner}:`;
  const keys = () => {
    const native = storage(kind), scope = prefix(), found: string[] = [];
    if (!native || !scope) return found;
    for (let i = 0; i < native.length; i++) {
      const key = native.key(i);
      if (key?.startsWith(scope)) found.push(key.slice(scope.length));
    }
    return found;
  };
  return {
    get length() { return keys().length; },
    key(index: number) { return keys()[index] ?? null; },
    getItem(key: string) {
      const scope = prefix();
      return scope ? storage(kind)?.getItem(scope + key) ?? null : null;
    },
    setItem(key: string, value: string) {
      const scope = prefix();
      if (scope) storage(kind)?.setItem(scope + key, value);
    },
    removeItem(key: string) {
      const scope = prefix();
      if (scope) storage(kind)?.removeItem(scope + key);
    },
    clear() { keys().forEach(key => { const scope = prefix(); if (scope) storage(kind)?.removeItem(scope + key); }); },
  };
}

export function isPrivateStorageEvent(event: StorageEvent, resource: string) {
  return owner !== null && event.storageArea === storage("localStorage") &&
    event.key === `${PRIVATE_STORAGE_PREFIX}${owner}:${resource}`;
}

export const privateLocalStorage = facade("localStorage");
export const privateSessionStorage = facade("sessionStorage");
