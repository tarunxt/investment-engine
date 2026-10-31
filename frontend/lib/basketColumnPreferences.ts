/** Tab-session display preferences only; callers include authenticated owner/broker/market. */
const prefix = "credx:basket-columns:v1:";
function labels(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(label => typeof label === "string" && label.length <= 128)
    ? [...new Set(value)] : [];
}
export function readBasketColumnPreferences(scope: string): string[] {
  try {
    const raw = window.sessionStorage.getItem(prefix + scope);
    return raw ? labels(JSON.parse(raw)) : [];
  } catch { return []; }
}
export function writeBasketColumnPreferences(scope: string, hidden: string[]) {
  try { window.sessionStorage.setItem(prefix + scope, JSON.stringify(labels(hidden))); }
  catch { /* Restricted storage must never prevent using the basket. */ }
}
