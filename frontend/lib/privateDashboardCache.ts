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

const DURABLE_UI_RESOURCES = [
  'investment-engine:model-mixes:v1',
  // Inert pending review identity must survive same-owner module refresh,
  // while full logout/identity purge still removes it. No request payload.
  'investment-engine:privacy-review-pending:v1',
  'investment-engine:concept-f:recommendation-layout:v1',
  'investment-engine:final-actionables:score-matrix-formula-config:v1',
] as const;

function purge(storage: StorageLike | null, preserveTemplateOwner?: number) {
  if (!storage) return 0;
  const preserve = new Set(Number.isSafeInteger(preserveTemplateOwner) && preserveTemplateOwner! > 0
    ? [...DURABLE_UI_RESOURCES,
      `investment-engine:console-sidebar-names:user:${preserveTemplateOwner}:v1`,
      `investment-engine:console-sidebar-child-order:user:${preserveTemplateOwner}:v1`,
      `investment-engine:console-sidebar-order:user:${preserveTemplateOwner}:v2`,
    ].map(resource => `investment-engine:private:v1:${preserveTemplateOwner}:${resource}`) : []);
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (
      key &&
      !preserve.has(key) &&
      PRIVATE_DASHBOARD_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      keys.push(key);
    }
  }
  keys.forEach((key) => storage.removeItem(key));
  return keys.length;
}

export function purgePrivateDashboardCache(storage: StorageLike | null) {
  return purge(storage);
}

// Module-policy refresh invalidates data caches, not this same owner's existing
// inert model-template, column-layout, advisory-formula and exact same-owner
// navigation-label/order preferences. Identity/logout still
// use the full purge. This allowlist contains no cached financial/source data.
export function purgePrivateModuleDashboardCache(storage: StorageLike | null, owner: number | null) {
  return purge(storage, owner ?? undefined);
}

export function purgeBrowserPrivateDashboardCaches() {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    try { removed += purgePrivateDashboardCache(window[kind]); } catch { /* Storage may be disabled. */ }
  }
  return removed;
}

export function purgeBrowserPrivateModuleCaches(owner: number | null) {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    try { removed += purgePrivateModuleDashboardCache(window[kind], owner); } catch { /* Storage may be disabled. */ }
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
