const API_TIMESTAMP_TIME_ZONE_PATTERN = /([zZ]|[+-]\d{2}:?\d{2})$/;

export function parseApiTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const timestamp = API_TIMESTAMP_TIME_ZONE_PATTERN.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime()) ? null : date;
}

type FormatApiTimestampOptions<TEmptyValue extends string | null = string> = {
  emptyValue?: TEmptyValue;
  locale?: string;
  timeZone?: string;
  timeZoneName?: 'short' | 'long' | 'shortOffset' | 'longOffset' | 'shortGeneric' | 'longGeneric';
  weekday?: 'long' | 'short' | 'narrow';
  year?: 'numeric' | '2-digit';
  month?: 'numeric' | '2-digit' | 'long' | 'short' | 'narrow';
  day?: 'numeric' | '2-digit';
  hour?: 'numeric' | '2-digit';
  minute?: 'numeric' | '2-digit';
  second?: 'numeric' | '2-digit';
};

export function formatApiTimestamp<TEmptyValue extends string | null = string>(
  value: string | null | undefined,
  {
    emptyValue = '-' as TEmptyValue,
    locale = 'en-IN',
    timeZone = 'Asia/Kolkata',
    timeZoneName = 'short',
    weekday,
    year = 'numeric',
    month = 'short',
    day = 'numeric',
    hour = 'numeric',
    minute = '2-digit',
    second = '2-digit',
  }: FormatApiTimestampOptions<TEmptyValue> = {},
): string | TEmptyValue {
  const date = parseApiTimestamp(value);
  if (!date) return value || emptyValue;

  return date.toLocaleString(locale, {
    timeZone,
    weekday,
    year,
    month,
    day,
    hour,
    minute,
    second,
    timeZoneName,
  });
}

/** Compact display only; retain the original timestamp for quote eligibility/provenance. */
export function formatCompactQuoteTime(value: string | null | undefined): string {
  const date = parseApiTimestamp(value);
  if (!date) return 'Unavailable';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('day')} ${part('month')}: ${part('hour')}:${part('minute')}:${part('second')} IST`;
}
