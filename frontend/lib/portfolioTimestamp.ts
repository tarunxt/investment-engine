/** Display only instants with explicit source timezone metadata. Never infer a zone. */
export function formatPortfolioTimestamp(value: string | null | undefined, timeOnly = false, { showTimezone = true } = {}): string {
  if (!value || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return 'Not recorded (timezone unknown)';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not recorded (invalid timestamp)';
  const timestamp = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    ...(timeOnly ? {} : { dateStyle: 'medium' as const }),
    timeStyle: 'short',
  }).format(date);
  return showTimezone ? `${timestamp} IST (UTC+05:30)` : timestamp;
}
