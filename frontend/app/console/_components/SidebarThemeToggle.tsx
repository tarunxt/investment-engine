"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Monitor, Moon, Sun } from "lucide-react";

import {
  applyThemePreference,
  getStoredThemePreference,
  isThemePreference,
  persistThemePreference,
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

// The shared event carries the immediately selected preference. Honor that
// projection even when another caller has not persisted it yet; storage events
// deliberately re-read the persisted source instead.
let notifiedTheme: ThemePreference | undefined;
let themeSubscriptions = 0;
function subscribeTheme(onChange: () => void) {
  if (themeSubscriptions++ === 0) notifiedTheme = undefined;
  const handleThemeChanged = (event: Event) => {
    notifiedTheme = event instanceof CustomEvent && isThemePreference(event.detail)
      ? event.detail : getStoredThemePreference() ?? "light";
    onChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) {
      notifiedTheme = getStoredThemePreference() ?? "light";
      onChange();
    }
  };
  window.addEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
    window.removeEventListener("storage", handleStorage);
    if (--themeSubscriptions === 0) notifiedTheme = undefined;
  };
}

function themeSnapshot(): ThemePreference {
  return notifiedTheme ?? getStoredThemePreference() ?? "light";
}

function subscribeSystemTheme(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function systemThemeSnapshot() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function SidebarThemeToggle({presentation='sidebar',disabled=false}:{presentation?:'sidebar'|'profile';disabled?:boolean}={}) {
  const inFlight=useRef(false);
  const themePreference = useSyncExternalStore(subscribeTheme, themeSnapshot, () => "light");
  const systemDark = useSyncExternalStore(subscribeSystemTheme, systemThemeSnapshot, () => false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedTheme =
    themePreference === "system"
      ? (systemDark?"dark":"light")
      : themePreference;

  async function handleThemeSelect(nextTheme: ThemePreference) {
    if(disabled||inFlight.current)return;
    if (nextTheme === resolvedTheme && themePreference !== "system") {
      return;
    }

    inFlight.current=true;
    setError(null);
    setSaving(true);
    persistThemePreference(nextTheme);
    applyThemePreference(nextTheme);

    try {
      await apiService.updateProfile({ theme_preference: nextTheme });
    } catch (nextError) {
      setError(getThemeErrorMessage(nextError));
    } finally {
      inFlight.current=false;
      setSaving(false);
    }
  }

  return (
    <div className={presentation==='profile'?'space-y-3':'mx-3 rounded-2xl border border-sidebar-border bg-sidebar-accent/70 p-3'}>
      <div className={presentation==='profile'?'sr-only':'flex items-start justify-between gap-3'}>
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

      <div className={presentation==='profile'?'flex flex-wrap gap-3':'mt-3 grid grid-cols-2 gap-2'}>
        {[
          {
            value: "light" as const,
            label: presentation==='profile'?'Calm light':'Light',
            icon: Sun,
          },
          {
            value: "dark" as const,
            label: "Dark",
            icon: Moon,
          },
          ...(presentation==='profile'?[{value:'system' as const,label:'System',icon:Monitor}]:[]),
        ].map((option) => {
          const isActive = presentation==='profile'?themePreference===option.value:resolvedTheme === option.value;

          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              disabled={saving||disabled}
              onClick={() => {
                void handleThemeSelect(option.value);
              }}
              className={presentation==='profile'?cn('concept-f-profile-theme',isActive?'is-active':''):cn(
                "flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                isActive
                  ? "border-sidebar-ring bg-sidebar text-sidebar-foreground shadow-sm"
                  : "border-sidebar-border bg-transparent text-sidebar-foreground/75 hover:bg-sidebar hover:text-sidebar-foreground",
                saving ? "cursor-wait opacity-80" : "",
              )}
            >
              <option.icon aria-hidden="true" className={presentation==='profile'?'sr-only':'size-4'} />
              {option.label}
            </button>
          );
        })}
      </div>

      <p className={presentation==='profile'?'sr-only':'mt-2 text-xs leading-5 text-muted-foreground'}>
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
