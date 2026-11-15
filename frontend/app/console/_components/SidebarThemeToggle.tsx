"use client";

import { useEffect, useState } from "react";
import { Loader2, Moon, Sun } from "lucide-react";

import {
  applyThemePreference,
  getStoredThemePreference,
  isThemePreference,
  persistThemePreference,
  resolveThemePreference,
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { apiService } from "@/services/api";

function getThemeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Could not sync your theme preference right now.";
}

export function SidebarThemeToggle() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    () => getStoredThemePreference() ?? "light",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncThemePreference = () => {
      setThemePreference(getStoredThemePreference() ?? "light");
    };

    const handleThemeChanged = (event: Event) => {
      const preference =
        event instanceof CustomEvent ? event.detail : getStoredThemePreference();

      if (!isThemePreference(preference)) {
        syncThemePreference();
        return;
      }

      setThemePreference(preference);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) {
        return;
      }

      syncThemePreference();
    };

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChanged = () => {
      const storedTheme = getStoredThemePreference();
      if (storedTheme === "system") {
        setThemePreference("system");
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
  }, []);

  const resolvedTheme =
    themePreference === "system"
      ? resolveThemePreference(themePreference)
      : themePreference;

  async function handleThemeSelect(nextTheme: "light" | "dark") {
    if (nextTheme === resolvedTheme && themePreference !== "system") {
      return;
    }

    setError(null);
    setSaving(true);
    setThemePreference(nextTheme);
    persistThemePreference(nextTheme);
    applyThemePreference(nextTheme);

    try {
      await apiService.updateProfile({ theme_preference: nextTheme });
    } catch (nextError) {
      setError(getThemeErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-3 rounded-2xl border border-sidebar-border bg-sidebar-accent/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Appearance
          </p>
          <p className="mt-1 text-sm font-semibold text-sidebar-accent-foreground">
            Theme
          </p>
        </div>
        {saving ? (
          <Loader2 className="mt-0.5 size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          {
            value: "light" as const,
            label: "Light",
            icon: Sun,
          },
          {
            value: "dark" as const,
            label: "Dark",
            icon: Moon,
          },
        ].map((option) => {
          const isActive = resolvedTheme === option.value;

          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              disabled={saving}
              onClick={() => {
                void handleThemeSelect(option.value);
              }}
              className={cn(
                "flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                isActive
                  ? "border-sidebar-ring bg-sidebar text-sidebar-foreground shadow-sm"
                  : "border-sidebar-border bg-transparent text-sidebar-foreground/75 hover:bg-sidebar hover:text-sidebar-foreground",
                saving ? "cursor-wait opacity-80" : "",
              )}
            >
              <option.icon className="size-4" />
              {option.label}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {themePreference === "system"
          ? `System mode was active. Current system theme: ${resolvedTheme}.`
          : "Updates the console theme immediately and saves it to your profile."}
      </p>

      {error ? (
        <p className="mt-2 text-xs leading-5 text-rose-600 dark:text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
