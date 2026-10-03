// These derived snapshots are an optional startup aid, never the source of truth.
// Keep the entire previous snapshot when a replacement cannot fit. Do not evict
// other keys or retry with fewer rows/jobs: that would make a partial source group
// look complete. A reload permits another attempt if the storage budget changes.
const quotaBlockedKeys = new WeakMap<Storage, Set<string>>();

export function writeOptionalBrowserCache(key: string, createPayload: () => unknown): boolean {
  if (typeof window === "undefined") return false;

  const storage = window.localStorage;
  if (quotaBlockedKeys.get(storage)?.has(key)) return false;

  // Only setItem quota failures are optional. Serialization/programming errors
  // still reach the caller's existing diagnostic.
  const serialized = JSON.stringify(createPayload());
  try {
    storage.setItem(key, serialized);
    return true;
  } catch (error) {
    const quotaError = error && typeof error === "object" && "name" in error && (
      error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    );
    if (!quotaError) throw error;

    const blocked = quotaBlockedKeys.get(storage) ?? new Set<string>();
    blocked.add(key);
    quotaBlockedKeys.set(storage, blocked);
    console.info("Browser storage is full; skipping this optional cache until reload. Loaded data is unchanged:", key);
    return false;
  }
}
