/** Saved ledgers use the same separator between reasons and before a session date. */
export function technicalReason(reason: string): string {
  const entries = reason.split(/ · (?!\d{4}-\d{2}-\d{2}\b)/);
  return [...new Set(entries)].join(" · ");
}
