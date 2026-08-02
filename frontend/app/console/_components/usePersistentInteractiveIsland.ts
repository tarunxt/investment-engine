"use client";

import { useCallback, useSyncExternalStore } from "react";

const OPEN_VALUE = "open";
const OPEN_EVENT = "investor:interactive-island-opened";
const memoryOpenKeys = new Set<string>();

function isOpen(storageKey: string) {
  if (memoryOpenKeys.has(storageKey)) return true;
  try {
    return window.localStorage.getItem(storageKey) === OPEN_VALUE;
  } catch {
    return false;
  }
}

export function usePersistentInteractiveIsland(storageKey: string) {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === storageKey) {
        onStoreChange();
      }
    };
    const handleOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail === storageKey) onStoreChange();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(OPEN_EVENT, handleOpen);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(OPEN_EVENT, handleOpen);
    };
  }, [storageKey]);

  const openState = useSyncExternalStore(
    subscribe,
    () => isOpen(storageKey),
    () => false,
  );

  const open = useCallback(() => {
    // Keep an in-memory fallback so privacy-restricted storage can never
    // prevent the current page from opening the requested screen.
    memoryOpenKeys.add(storageKey);
    try {
      window.localStorage.setItem(storageKey, OPEN_VALUE);
    } catch {
      // The in-memory fallback above remains authoritative for this page.
    }
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: storageKey }));
  }, [storageKey]);

  return { isOpen: openState, open };
}
