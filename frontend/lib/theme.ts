const LEGACY_THEME_STORAGE_KEY = "investor:theme-preference";
export const THEME_STORAGE_KEY = "investment-engine:theme-preference";
export const THEME_CHANGED_EVENT = "investment-engine:theme-preference-changed";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.includes(value as ThemePreference);
}

export function getStoredThemePreference(): ThemePreference | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedTheme =
    window.localStorage.getItem(THEME_STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  return isThemePreference(storedTheme) ? storedTheme : null;
}

export function resolveThemePreference(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") {
    return preference;
  }

  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemePreference(preference: ThemePreference) {
  if (typeof document === "undefined") {
    return;
  }

  const resolvedTheme = resolveThemePreference(preference);
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.style.colorScheme = resolvedTheme;
}

export function persistThemePreference(preference: ThemePreference) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: preference }));
}
