import type { KiteConnectionChange } from "@/types/api";

const storageKey = "credx.kite.settings.login";

export function beginKiteSettingsLogin(loginUrl: string, change: KiteConnectionChange) {
  const url = new URL(loginUrl);
  if (url.origin !== "https://kite.zerodha.com" || url.pathname !== "/connect/login") {
    throw new Error("The Kite login URL is unavailable. Refresh and try again.");
  }
  const state = crypto.randomUUID();
  sessionStorage.setItem(storageKey, JSON.stringify({ state, change, started: Date.now() }));
  url.searchParams.set("redirect_params", new URLSearchParams({ broker_state: state }).toString());
  window.location.assign(url.href);
}

export function takeKiteSettingsLogin(state: string): KiteConnectionChange {
  const pending = JSON.parse(sessionStorage.getItem(storageKey) || "null");
  if (pending?.state !== state || !pending.change?.expected_revision ||
      Date.now() - pending.started > 15 * 60_000) {
    throw new Error("This sign-in has expired. Start again from Connected Brokers.");
  }
  sessionStorage.removeItem(storageKey);
  return pending.change;
}
