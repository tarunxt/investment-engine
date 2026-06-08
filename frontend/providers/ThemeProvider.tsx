"use client";

import { useEffect, useState } from "react";
import { apiService } from "@/services/api";
import {
  applyThemePreference,
  getStoredThemePreference,
  isThemePreference,
  persistThemePreference,
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference() ?? "light");

  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    const storedTheme = getStoredThemePreference();

    if (storedTheme) {
      applyThemePreference(storedTheme);
    }

    let cancelled = false;

    async function loadServerThemePreference() {
      try {
        const profile = await apiService.getProfile();
        const serverTheme = profile.theme_preference;

        if (!isThemePreference(serverTheme) || cancelled) {
          return;
        }

        setThemePreference(serverTheme);
        persistThemePreference(serverTheme);
        applyThemePreference(serverTheme);
      } catch (err) {
        console.warn("Failed to load theme preference:", err);
      }
    }

    void loadServerThemePreference();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleThemeChanged = (event: Event) => {
      const preference = event instanceof CustomEvent ? event.detail : getStoredThemePreference();

      if (!isThemePreference(preference)) {
        return;
      }

      setThemePreference(preference);
      applyThemePreference(preference);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) {
        return;
      }

      const storedTheme = getStoredThemePreference();
      if (!storedTheme) {
        return;
      }

      setThemePreference(storedTheme);
      applyThemePreference(storedTheme);
    };

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChanged = () => {
      if (themePreference === "system") {
        applyThemePreference("system");
      }
    };

    window.addEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
    window.addEventListener("storage", handleStorage);
    mediaQuery.addEventListener("change", handleSystemThemeChanged);

    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
      window.removeEventListener("storage", handleStorage);
      mediaQuery.removeEventListener("change", handleSystemThemeChanged);
    };
  }, [themePreference]);

  return children;
}
