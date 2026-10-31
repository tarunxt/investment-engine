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

export type BasketColumnLayout = { hidden: string[]; order: string[]; names: Record<string, string> };
export const emptyBasketColumnLayout = (): BasketColumnLayout => ({ hidden: [], order: [], names: {} });
export function normalizeBasketColumnLayout(value: unknown): BasketColumnLayout {
  const raw = value && typeof value === 'object' ? value as Partial<BasketColumnLayout> : {};
  const names: Record<string, string> = {};
  if (raw.names && typeof raw.names === 'object') for (const [id, name] of Object.entries(raw.names).slice(0, 100)) {
    if (id.length <= 128 && typeof name === 'string' && name.trim() && name.length <= 64 && !['__proto__', 'constructor', 'prototype'].includes(id)) names[id] = name.trim();
  }
  return { hidden: labels(raw.hidden), order: labels(raw.order), names };
}
export function readBasketColumnLayout(scope: string): BasketColumnLayout {
  try {
    const raw = window.sessionStorage.getItem('credx:basket-layout:v2:' + scope);
    return raw ? normalizeBasketColumnLayout(JSON.parse(raw)) : { ...emptyBasketColumnLayout(), hidden: readBasketColumnPreferences(scope) };
  } catch { return emptyBasketColumnLayout(); }
}
export function writeBasketColumnLayout(scope: string, layout: BasketColumnLayout) {
  try { window.sessionStorage.setItem('credx:basket-layout:v2:' + scope, JSON.stringify(normalizeBasketColumnLayout(layout))); }
  catch { /* In-memory controls remain usable. */ }
}
export function orderedBasketColumns(ids: string[], order: string[] = []): string[] {
  return [...new Set([...order.filter(id => ids.includes(id)), ...ids])];
}
export function moveBasketColumn(ids: string[], id: string, destination: number): string[] {
  const current = ids.indexOf(id);
  if (current < 0 || destination < 0 || destination >= ids.length) return ids;
  const next = [...ids]; next.splice(current, 1); next.splice(destination, 0, id); return next;
}
