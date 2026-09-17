"use client";

import { useCallback, useEffect, useState } from "react";

export const DEFAULT_EVENT_TRENDS_TIMEOUT_SECONDS = 30;
export const MIN_EVENT_TRENDS_TIMEOUT_SECONDS = 5;
export const MAX_EVENT_TRENDS_TIMEOUT_SECONDS = 120;

const STORAGE_KEY = "bullpen-event-trends-timeout-seconds-v1";
const UPDATED_EVENT = "bullpen-event-trends-timeout-updated";

export function normalizeEventTrendsTimeoutSeconds(value: unknown) {
  if (value == null || value === "") return DEFAULT_EVENT_TRENDS_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!Number.isInteger(seconds)) return DEFAULT_EVENT_TRENDS_TIMEOUT_SECONDS;
  return Math.min(
    MAX_EVENT_TRENDS_TIMEOUT_SECONDS,
    Math.max(MIN_EVENT_TRENDS_TIMEOUT_SECONDS, seconds),
  );
}

function readSavedTimeoutSeconds() {
  if (typeof window === "undefined") return DEFAULT_EVENT_TRENDS_TIMEOUT_SECONDS;
  try {
    return normalizeEventTrendsTimeoutSeconds(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_EVENT_TRENDS_TIMEOUT_SECONDS;
  }
}

export function useEventTrendsTimeout() {
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    DEFAULT_EVENT_TRENDS_TIMEOUT_SECONDS,
  );

  useEffect(() => {
    const sync = () => setTimeoutSeconds(readSavedTimeoutSeconds());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(UPDATED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(UPDATED_EVENT, sync);
    };
  }, []);

  const saveTimeoutSeconds = useCallback((value: number) => {
    const next = normalizeEventTrendsTimeoutSeconds(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // The current tab still uses the selected value when storage is blocked.
    }
    setTimeoutSeconds(next);
    window.dispatchEvent(new Event(UPDATED_EVENT));
  }, []);

  return { timeoutSeconds, saveTimeoutSeconds };
}
