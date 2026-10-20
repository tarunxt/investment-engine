type StorageLike = Pick<Storage, "key" | "length" | "removeItem">;
const PRIVATE_CACHE_OWNER_KEY = "investment-engine:private-cache-owner:v1";

const PRIVATE_DASHBOARD_CACHE_PREFIXES = [
  "investment-engine:private:v1:",
  "investment-engine:trading-bots-overview:",
  "investment-engine:dashboard",
  "investment-engine:final-actionables:",
  "investment-engine:rebalance-workflow-state:",
  "investment-engine:bullpen-",
  "credx-stock-parameters-v1",
  "polymarketBot.ec2Commands",
  "bullpenAi.ec2Commands",
] as const;

export function purgePrivateDashboardCache(storage: StorageLike | null) {
  if (!storage) return 0;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (
      key &&
      PRIVATE_DASHBOARD_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      keys.push(key);
    }
  }
  keys.forEach((key) => storage.removeItem(key));
  return keys.length;
}

export function purgeBrowserPrivateDashboardCaches() {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    try { removed += purgePrivateDashboardCache(window[kind]); } catch { /* Storage may be disabled. */ }
  }
  return removed;
}

export function reconcileBrowserPrivateCacheOwner(userId: number) {
  if (typeof window === "undefined") return false;
  const nextOwner = String(userId);
  try {
    const previousOwner = window.localStorage.getItem(PRIVATE_CACHE_OWNER_KEY);
    const changed = previousOwner !== nextOwner;
    if (changed) purgeBrowserPrivateDashboardCaches();
    window.localStorage.setItem(PRIVATE_CACHE_OWNER_KEY, nextOwner);
    return changed;
  } catch { return false; }
}

export function clearBrowserPrivateCacheOwner() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(PRIVATE_CACHE_OWNER_KEY); } catch { /* No persistent access. */ }
}
