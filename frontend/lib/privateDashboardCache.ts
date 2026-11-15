type StorageLike = Pick<Storage, "key" | "length" | "removeItem">;
const PRIVATE_CACHE_OWNER_KEY = "investment-engine:private-cache-owner:v1";

const PRIVATE_DASHBOARD_CACHE_PREFIXES = [
  "investment-engine:dashboard-overview-cache:",
  "investment-engine:dashboard:final-actionables:",
  "investment-engine:final-actionables:runs:",
  "investment-engine:final-actionables:historical-rows:",
  "investment-engine:rebalance-workflow-state:",
  "investment-engine:bullpen-ai:",
  "investment-engine:bullpen-auto-run-status:",
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
  return (
    purgePrivateDashboardCache(window.localStorage) +
    purgePrivateDashboardCache(window.sessionStorage)
  );
}

export function reconcileBrowserPrivateCacheOwner(userId: number) {
  if (typeof window === "undefined") return false;
  const nextOwner = String(userId);
  const previousOwner = window.localStorage.getItem(PRIVATE_CACHE_OWNER_KEY);
  const changed = Boolean(previousOwner && previousOwner !== nextOwner);
  if (changed) {
    purgeBrowserPrivateDashboardCaches();
  }
  window.localStorage.setItem(PRIVATE_CACHE_OWNER_KEY, nextOwner);
  return changed;
}

export function clearBrowserPrivateCacheOwner() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PRIVATE_CACHE_OWNER_KEY);
}
