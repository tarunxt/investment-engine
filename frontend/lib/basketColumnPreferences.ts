/** Legacy tab-session display preferences; callers include authenticated owner/broker/market. */
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
  const key = 'credx:basket-layout:v2:' + scope;
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      const raw = window[store].getItem(key);
      if (!raw) continue;
      const layout = normalizeBasketColumnLayout(JSON.parse(raw));
      if (store === 'sessionStorage') writeBasketColumnLayout(scope, layout);
      return layout;
    } catch { /* Try the next available store. */ }
  }
  const hidden = readBasketColumnPreferences(scope);
  const layout = { ...emptyBasketColumnLayout(), hidden };
  if (hidden.length) writeBasketColumnLayout(scope, layout);
  return layout;
}
export function writeBasketColumnLayout(scope: string, layout: BasketColumnLayout) {
  const key = 'credx:basket-layout:v2:' + scope;
  const value = JSON.stringify(normalizeBasketColumnLayout(layout));
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      window[store].setItem(key, value);
      return;
    } catch { /* Restricted storage must never prevent using the basket. */ }
  }
}
export function orderedBasketColumns(ids: string[], order: string[] = []): string[] {
  return [...new Set([...order.filter(id => ids.includes(id)), ...ids])];
}
export function moveBasketColumn(ids: string[], id: string, destination: number): string[] {
  const current = ids.indexOf(id);
  if (current < 0 || destination < 0 || destination >= ids.length) return ids;
  const next = [...ids]; next.splice(current, 1); next.splice(destination, 0, id); return next;
}
