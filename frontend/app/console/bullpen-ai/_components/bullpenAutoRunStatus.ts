/**
 * Small, framework-free helpers for the lightweight Bullpen Auto Run status
 * endpoint.  Keeping this separate from the full Auto-Live summary makes it
 * safe to render scheduler badges without waiting for run history, Celery
 * inspection, or runtime diagnostics.
 */

export const BULLPEN_AUTO_RUN_STATUS_CACHE_VERSION = 3;
export const BULLPEN_AUTO_RUN_STATUS_CACHE_KEY =
  "investment-engine:bullpen-ai:auto-run-status:v3";
export const DEFAULT_BULLPEN_AUTO_RUN_STATUS_FRESH_FOR_MS = 60_000;
export const DEFAULT_BULLPEN_AUTO_RUN_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type BullpenAutoRunRuntimeMode =
  | "dry-run"
  | "analysis-only"
  | "live-trading";

export type BullpenAutoRunActiveRunStatus = "running" | "confirming";

/**
 * Deliberately minimal, UI-normalized shape for `/polymarket/auto-live/status`.
 *
 * The public endpoint uses `scheduler` and `configuration` to make clear that
 * it is not the legacy full summary. This normalized representation is only
 * used by the UI/cache and keeps the focused endpoint contract explicit.
 */
export type BullpenAutoRunStatusData = {
  state: {
    running: boolean;
    paused: boolean;
    emergency_stopped: boolean;
    mode: BullpenAutoRunRuntimeMode;
    status?: string | null;
    next_run_at?: string | null;
    last_run_at?: string | null;
    last_run_id?: string | null;
    active_run_id?: string | null;
    active_run_status?: BullpenAutoRunActiveRunStatus | null;
    server_now?: string | null;
  };
  settings: {
    auto_live_enabled: boolean;
    strategy_profile?: string | null;
    console_order_usd?: number | null;
    console_auto_start_at?: string | null;
    console_auto_refresh_minutes?: number | null;
  };
  fetched_at?: string | null;
};

export type BullpenAutoRunStatusLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "retrying"
  | "error"
  | "timeout";

export type BullpenAutoRunStatusBadges = {
  statusLabel: "Enabled" | "Disabled" | "Paused" | "Unavailable" | "Retrying" | null;
  modeLabel:
    | "Dry run"
    | "Analysis only"
    | "Live trading"
    | "Check failed"
    | "Retrying"
    | null;
  /** True when the labels show a previously successful response being revalidated. */
  isStale: boolean;
  /** True while the caller has a request in flight but can still show cached data. */
  isUpdating: boolean;
};

export type BullpenAutoRunStatusCacheEntry = {
  version: typeof BULLPEN_AUTO_RUN_STATUS_CACHE_VERSION;
  savedAt: number;
  data: BullpenAutoRunStatusData;
};

export type CachedBullpenAutoRunStatus = {
  data: BullpenAutoRunStatusData;
  savedAt: number;
  ageMs: number;
  isStale: boolean;
};

export type BullpenAutoRunStatusCacheOptions = {
  now?: number;
  freshForMs?: number;
  maxAgeMs?: number;
};

export type BullpenAutoRunStatusStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

/**
 * Status is user-specific.  Never reuse a previous account's scheduler state
 * after logout/login in the same browser tab.
 */
export function getBullpenAutoRunStatusCacheKey(
  userId: string | number | null | undefined,
): string | null {
  if (userId === null || userId === undefined || userId === "") return null;
  return `${BULLPEN_AUTO_RUN_STATUS_CACHE_KEY}:${String(userId)}`;
}

export type BullpenAutoRunPollingInput = {
  visibilityState?: string | null;
  initialLoadState: BullpenAutoRunStatusLoadState;
  runStatus?: string | null;
  requestInFlight?: boolean;
};

/**
 * Shares one in-flight resource fetch across React Strict Mode remounts and
 * concurrent callers, then releases it after it settles for a later refresh.
 */
export function createBullpenAutoRunRequestDeduper<T>() {
  let inFlight: Promise<T> | null = null;

  return (load: () => Promise<T>): Promise<T> => {
    if (!inFlight) {
      inFlight = load().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

type AbortableSharedRequest<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
};

function createAbortError() {
  return new DOMException("Request aborted", "AbortError");
}

/**
 * Shares a resource request without leaking it after its final consumer
 * unmounts.  A microtask grace period keeps React Strict Mode's intentional
 * effect cleanup/remount cycle attached to the same request rather than
 * issuing a second one.
 */
export function createAbortableBullpenAutoRunRequestDeduper<T>(
  load: (signal: AbortSignal) => Promise<T>,
) {
  let inFlight: AbortableSharedRequest<T> | null = null;

  return (consumerSignal: AbortSignal): Promise<T> => {
    if (consumerSignal.aborted) {
      return Promise.reject(createAbortError());
    }

    let request = inFlight;
    if (!request || request.controller.signal.aborted) {
      const controller = new AbortController();
      const nextRequest: AbortableSharedRequest<T> = {
        controller,
        promise: Promise.resolve() as Promise<T>,
        subscribers: 0,
        settled: false,
      };
      nextRequest.promise = Promise.resolve()
        .then(() => load(controller.signal))
        .finally(() => {
          nextRequest.settled = true;
          if (inFlight === nextRequest) {
            inFlight = null;
          }
        });
      inFlight = nextRequest;
      request = nextRequest;
    }

    request.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        request.subscribers = Math.max(0, request.subscribers - 1);
        if (request.subscribers !== 0 || request.settled) return;

        queueMicrotask(() => {
          if (
            request.subscribers === 0 &&
            !request.settled &&
            inFlight === request
          ) {
            request.controller.abort();
          }
        });
      };
      const onAbort = () => {
        consumerSignal.removeEventListener("abort", onAbort);
        release();
        reject(createAbortError());
      };
      const cleanup = () => {
        consumerSignal.removeEventListener("abort", onAbort);
        release();
      };

      consumerSignal.addEventListener("abort", onAbort, { once: true });
      request.promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isNullableFiniteNumber(
  value: unknown,
): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
}

function normalizeMode(value: unknown): BullpenAutoRunRuntimeMode | null {
  if (
    value === "dry-run" ||
    value === "analysis-only" ||
    value === "live-trading"
  ) {
    return value;
  }
  return null;
}

function isNullableActiveRunStatus(
  value: unknown,
): value is BullpenAutoRunActiveRunStatus | null | undefined {
  return (
    value === undefined ||
    value === null ||
    value === "running" ||
    value === "confirming"
  );
}

/**
 * Validates the persisted-only endpoint and returns a UI-normalized shape.
 * Invalid data is intentionally rejected rather than treated as a disabled
 * scheduler: callers can surface "Unavailable / Check failed" accurately.
 */
export function normalizeBullpenAutoRunStatusData(
  value: unknown,
): BullpenAutoRunStatusData | null {
  const root = asRecord(value);
  // Cached values use the small normalized representation below. Validate it
  // separately so cache reads do not need to masquerade as API responses.
  const cachedState = asRecord(root?.state);
  const cachedSettings = asRecord(root?.settings);
  if (root && cachedState && cachedSettings) {
    const mode = normalizeMode(cachedState.mode);
    if (
      mode === null ||
      typeof cachedState.running !== "boolean" ||
      typeof cachedState.paused !== "boolean" ||
      typeof cachedState.emergency_stopped !== "boolean" ||
      typeof cachedSettings.auto_live_enabled !== "boolean" ||
      !isNullableString(cachedState.status) ||
      !isNullableString(cachedState.next_run_at) ||
      !isNullableString(cachedState.last_run_at) ||
      !isNullableString(cachedState.last_run_id) ||
      !isNullableString(cachedState.active_run_id) ||
      !isNullableActiveRunStatus(cachedState.active_run_status) ||
      !isNullableString(cachedSettings.strategy_profile) ||
      !isNullableFiniteNumber(cachedSettings.console_order_usd) ||
      !isNullableString(cachedSettings.console_auto_start_at) ||
      !isNullableFiniteNumber(cachedSettings.console_auto_refresh_minutes) ||
      !isNullableString(root.fetched_at)
    ) {
      return null;
    }

    return {
      state: {
        running: cachedState.running,
        paused: cachedState.paused,
        emergency_stopped: cachedState.emergency_stopped,
        mode,
        ...(cachedState.status === undefined
          ? {}
          : { status: cachedState.status }),
        ...(cachedState.next_run_at === undefined
          ? {}
          : { next_run_at: cachedState.next_run_at }),
        ...(cachedState.last_run_at === undefined
          ? {}
          : { last_run_at: cachedState.last_run_at }),
        ...(cachedState.last_run_id === undefined
          ? {}
          : { last_run_id: cachedState.last_run_id }),
        ...(cachedState.active_run_id === undefined
          ? {}
          : { active_run_id: cachedState.active_run_id }),
        ...(cachedState.active_run_status === undefined
          ? {}
          : { active_run_status: cachedState.active_run_status }),
      },
      settings: {
        auto_live_enabled: cachedSettings.auto_live_enabled,
        ...(cachedSettings.strategy_profile === undefined
          ? {}
          : { strategy_profile: cachedSettings.strategy_profile }),
        ...(cachedSettings.console_order_usd === undefined
          ? {}
          : { console_order_usd: cachedSettings.console_order_usd }),
        ...(cachedSettings.console_auto_start_at === undefined
          ? {}
          : { console_auto_start_at: cachedSettings.console_auto_start_at }),
        ...(cachedSettings.console_auto_refresh_minutes === undefined
          ? {}
          : {
              console_auto_refresh_minutes:
                cachedSettings.console_auto_refresh_minutes,
            }),
      },
      ...(root.fetched_at === undefined ? {} : { fetched_at: root.fetched_at }),
    };
  }

  const rawConfiguration = asRecord(root?.configuration);
  const rawScheduler = asRecord(root?.scheduler);
  if (
    !root ||
    root.source !== "persisted" ||
    !rawConfiguration ||
    !rawScheduler ||
    typeof root.refreshed_at !== "string"
  ) {
    return null;
  }

  const mode = normalizeMode(rawScheduler.mode);
  if (
    mode === null ||
    typeof rawScheduler.running !== "boolean" ||
    typeof rawScheduler.paused !== "boolean" ||
    typeof rawScheduler.emergency_stopped !== "boolean" ||
    typeof rawConfiguration.auto_live_enabled !== "boolean" ||
    !isNullableString(rawScheduler.status) ||
    !isNullableString(rawScheduler.next_run_at) ||
    !isNullableString(rawScheduler.last_run_at) ||
    !isNullableString(rawScheduler.last_run_id) ||
    !isNullableString(rawScheduler.active_run_id) ||
    !isNullableActiveRunStatus(rawScheduler.active_run_status) ||
    !isNullableString(rawConfiguration.strategy_profile) ||
    !isNullableFiniteNumber(rawConfiguration.console_order_usd) ||
    !isNullableString(rawConfiguration.console_auto_start_at) ||
    !isNullableFiniteNumber(rawConfiguration.console_auto_refresh_minutes)
  ) {
    return null;
  }

  return {
    state: {
      running: rawScheduler.running,
      paused: rawScheduler.paused,
      emergency_stopped: rawScheduler.emergency_stopped,
      mode,
      ...(rawScheduler.status === undefined
        ? {}
        : { status: rawScheduler.status }),
      ...(rawScheduler.next_run_at === undefined
        ? {}
        : { next_run_at: rawScheduler.next_run_at }),
      ...(rawScheduler.last_run_at === undefined
        ? {}
        : { last_run_at: rawScheduler.last_run_at }),
      ...(rawScheduler.last_run_id === undefined
        ? {}
        : { last_run_id: rawScheduler.last_run_id }),
      ...(rawScheduler.active_run_id === undefined
        ? {}
        : { active_run_id: rawScheduler.active_run_id }),
      ...(rawScheduler.active_run_status === undefined
        ? {}
        : { active_run_status: rawScheduler.active_run_status }),
    },
    settings: {
      auto_live_enabled: rawConfiguration.auto_live_enabled,
      ...(rawConfiguration.strategy_profile === undefined
        ? {}
        : { strategy_profile: rawConfiguration.strategy_profile }),
      ...(rawConfiguration.console_order_usd === undefined
        ? {}
        : { console_order_usd: rawConfiguration.console_order_usd }),
      ...(rawConfiguration.console_auto_start_at === undefined
        ? {}
        : { console_auto_start_at: rawConfiguration.console_auto_start_at }),
      ...(rawConfiguration.console_auto_refresh_minutes === undefined
        ? {}
        : {
            console_auto_refresh_minutes:
              rawConfiguration.console_auto_refresh_minutes,
          }),
    },
    fetched_at: root.refreshed_at,
  };
}

export function isBullpenAutoRunStatusData(
  value: unknown,
): boolean {
  return normalizeBullpenAutoRunStatusData(value) !== null;
}

export function createBullpenAutoRunStatusCacheEntry(
  data: BullpenAutoRunStatusData,
  savedAt = Date.now(),
): BullpenAutoRunStatusCacheEntry {
  return {
    version: BULLPEN_AUTO_RUN_STATUS_CACHE_VERSION,
    savedAt,
    data,
  };
}

export function serializeBullpenAutoRunStatusCache(
  data: BullpenAutoRunStatusData,
  savedAt = Date.now(),
): string {
  return JSON.stringify(createBullpenAutoRunStatusCacheEntry(data, savedAt));
}

/**
 * Reads a cache entry without pretending stale data is live.  A valid but old
 * entry is returned with `isStale: true`; entries beyond `maxAgeMs` are ignored.
 */
export function parseBullpenAutoRunStatusCache(
  rawValue: string | null | undefined,
  options: BullpenAutoRunStatusCacheOptions = {},
): CachedBullpenAutoRunStatus | null {
  if (!rawValue) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return null;
  }

  const entry = asRecord(parsed);
  if (
    !entry ||
    entry.version !== BULLPEN_AUTO_RUN_STATUS_CACHE_VERSION ||
    typeof entry.savedAt !== "number" ||
    !Number.isFinite(entry.savedAt) ||
    entry.savedAt < 0
  ) {
    return null;
  }

  const data = normalizeBullpenAutoRunStatusData(entry.data);
  if (!data) return null;

  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) return null;
  const ageMs = Math.max(0, now - entry.savedAt);
  const maxAgeMs =
    options.maxAgeMs ?? DEFAULT_BULLPEN_AUTO_RUN_STATUS_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || ageMs > maxAgeMs) {
    return null;
  }

  const freshForMs =
    options.freshForMs ?? DEFAULT_BULLPEN_AUTO_RUN_STATUS_FRESH_FOR_MS;
  if (!Number.isFinite(freshForMs) || freshForMs < 0) return null;

  return {
    data,
    savedAt: entry.savedAt,
    ageMs,
    isStale: ageMs > freshForMs,
  };
}

export function readCachedBullpenAutoRunStatus(
  storage: BullpenAutoRunStatusStorage | null | undefined,
  options: BullpenAutoRunStatusCacheOptions = {},
  cacheKey = BULLPEN_AUTO_RUN_STATUS_CACHE_KEY,
): CachedBullpenAutoRunStatus | null {
  if (!storage || !cacheKey) return null;
  try {
    return parseBullpenAutoRunStatusCache(
      storage.getItem(cacheKey),
      options,
    );
  } catch {
    return null;
  }
}

export function writeCachedBullpenAutoRunStatus(
  storage: BullpenAutoRunStatusStorage | null | undefined,
  data: BullpenAutoRunStatusData,
  savedAt = Date.now(),
  cacheKey = BULLPEN_AUTO_RUN_STATUS_CACHE_KEY,
): boolean {
  if (!storage || !cacheKey) return false;
  try {
    storage.setItem(
      cacheKey,
      serializeBullpenAutoRunStatusCache(data, savedAt),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearCachedBullpenAutoRunStatus(
  storage: BullpenAutoRunStatusStorage | null | undefined,
  cacheKey = BULLPEN_AUTO_RUN_STATUS_CACHE_KEY,
): void {
  try {
    if (cacheKey) storage?.removeItem?.(cacheKey);
  } catch {
    // Storage failures must never block the console.
  }
}

function modeLabel(mode: BullpenAutoRunRuntimeMode) {
  if (mode === "live-trading") return "Live trading" as const;
  if (mode === "analysis-only") return "Analysis only" as const;
  return "Dry run" as const;
}

/**
 * Produces finite badge states.  With cached data, labels remain the last known
 * scheduler values and `isStale` tells the UI to render an "Updating" or age
 * marker.  Without data, timeout/error states never fall back to Loading.
 */
export function getBullpenAutoRunStatusBadges(
  data: BullpenAutoRunStatusData | null | undefined,
  loadState: BullpenAutoRunStatusLoadState,
): BullpenAutoRunStatusBadges {
  const hasData = data !== null && data !== undefined;
  const isUpdating = loadState === "loading" || loadState === "retrying";

  if (hasData) {
    const schedulerReportedError = data.state.status === "error";
    const schedulerPaused =
      data.state.paused ||
      data.state.emergency_stopped ||
      data.state.status === "paused";
    const schedulerRunning = data.state.running && !schedulerPaused;

    // A prior run failure can leave the persisted status string at "error"
    // even after the durable scheduler booleans show that auto-runs are active
    // again. Keep the current scheduler status and configured mode visible;
    // `isStale` still exposes the reported error without replacing both badges.
    const statusLabel = !data.settings.auto_live_enabled
      ? "Disabled"
      : schedulerPaused
        ? "Paused"
        : schedulerReportedError && !schedulerRunning
          ? "Unavailable"
          : "Enabled";

    return {
      statusLabel,
      modeLabel: modeLabel(data.state.mode),
      isStale:
        schedulerReportedError ||
        loadState === "error" ||
        loadState === "timeout" ||
        isUpdating,
      isUpdating,
    };
  }

  if (loadState === "loading") {
    return {
      // Render a compact skeleton instead of text that could be mistaken for
      // a real scheduler state. A request deadline always transitions this to
      // the explicit unavailable/check-failed fallback.
      statusLabel: null,
      modeLabel: null,
      isStale: false,
      isUpdating: true,
    };
  }

  if (loadState === "retrying") {
    return {
      statusLabel: "Retrying",
      modeLabel: "Retrying",
      isStale: false,
      isUpdating: true,
    };
  }

  return {
    statusLabel: "Unavailable",
    modeLabel: "Check failed",
    isStale: false,
    isUpdating: false,
  };
}

/** Scheduler enabled and run-progress active are deliberately separate. */
export function isBullpenAutoRunSchedulerEnabled(
  data: BullpenAutoRunStatusData | null | undefined,
): boolean {
  return Boolean(
    data?.settings.auto_live_enabled &&
      data.state.running &&
      !data.state.paused &&
      !data.state.emergency_stopped,
  );
}

/** Returns an identity only for a persisted non-terminal workflow. */
export function getBullpenAutoRunActiveRunId(
  data: BullpenAutoRunStatusData | null | undefined,
): string | null {
  if (
    !data?.state.active_run_id ||
    (data.state.active_run_status !== "running" &&
      data.state.active_run_status !== "confirming")
  ) {
    return null;
  }
  return data.state.active_run_id;
}

export function isBullpenAutoRunProgressActive(
  data: BullpenAutoRunStatusData | null | undefined,
): boolean {
  return getBullpenAutoRunActiveRunId(data) !== null;
}

export type BullpenAutoRunRetryOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
};

/** Returns a deterministic, capped exponential retry delay (no jitter). */
export function getBullpenAutoRunStatusRetryDelay(
  failedAttempt: number,
  options: BullpenAutoRunRetryOptions = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const normalizedBase =
    Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 1_000;
  const normalizedMax =
    Number.isFinite(maxDelayMs) && maxDelayMs >= normalizedBase
      ? maxDelayMs
      : normalizedBase;
  const normalizedAttempt = Math.max(
    0,
    Math.floor(Number.isFinite(failedAttempt) ? failedAttempt : 0),
  );
  return Math.min(normalizedMax, normalizedBase * 2 ** normalizedAttempt);
}

/** A run needs high-frequency refresh only while it can still change. */
export function isBullpenAutoRunActive(
  runStatus: string | null | undefined,
): boolean {
  return (
    runStatus === "queued" ||
    runStatus === "pending" ||
    runStatus === "running" ||
    runStatus === "confirming"
  );
}

export function isBullpenAutoRunPageVisible(
  visibilityState: string | null | undefined,
): boolean {
  return visibilityState === "visible";
}

/**
 * Prevents pre-initial-load and hidden-tab polling.  Static scheduler
 * configuration should be fetched on mount/visibility revalidation, not in a
 * tight timer; this predicate is only for an active run-progress resource.
 */
export function shouldPollBullpenAutoRun(
  input: BullpenAutoRunPollingInput,
): boolean {
  return (
    input.initialLoadState === "ready" &&
    !input.requestInFlight &&
    isBullpenAutoRunPageVisible(input.visibilityState) &&
    isBullpenAutoRunActive(input.runStatus)
  );
}
