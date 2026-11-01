export type TotalDataStatusInfo = {
  source: string;
  capturedAt?: string | null;
  cachedAt?: number;
  pending?: boolean;
  failed?: boolean;
  complete: boolean;
  snapshotKnown?: boolean;
  historyHref?: string;
  historyLabel?: string;
};

// Availability describes this read, never the existence of records in another route.
export function snapshotAvailability(info: TotalDataStatusInfo) {
  const known = info.snapshotKnown ?? Boolean(info.capturedAt);
  if (info.failed) return known
    ? "Cannot verify saved snapshot availability · Last-known snapshot shown"
    : "Cannot verify saved snapshot availability";
  if (info.pending) return known
    ? "Checking saved snapshot availability · Last-known snapshot shown"
    : "Checking saved snapshot availability";
  if (known) return info.cachedAt !== undefined
    ? "Last-known saved snapshot · Current availability unverified"
    : "Saved snapshot available";
  return "No saved snapshot returned by the latest successful read";
}

export function SnapshotAvailability({ info }: { info: TotalDataStatusInfo }) {
  return <div role="status" aria-live="polite" aria-atomic="true">
    <p>{info.failed ? "Refresh failed · " : ""}{snapshotAvailability(info)}</p>
    {info.historyHref ? <a className="underline focus-visible:outline-2 focus-visible:outline-offset-2" href={info.historyHref}>
      {info.historyLabel ?? "View saved portfolio history"}
    </a> : null}
  </div>;
}

export function dataAge(
  value: string | number | null | undefined,
  now = Date.now(),
) {
  const time =
    typeof value === "number" ? value : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "age unknown";
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1
    ? "less than 1m old"
    : minutes < 60
      ? `${minutes}m old`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m old`;
}

export function TotalDataStatus({
  info,
  compact = false,
}: {
  info: TotalDataStatusInfo;
  compact?: boolean;
}) {
  if (compact)
    return (
      <p className="mt-2 text-xs leading-5">
        Source: {info.source} · {info.capturedAt ? `Snapshot ${dataAge(info.capturedAt)}` : "Snapshot time unavailable"}
        {info.cachedAt === undefined
          ? ""
          : ` · Browser cache ${dataAge(info.cachedAt)}`}
        {info.failed
          ? ` · Refresh failed · ${snapshotAvailability(info)}`
          : info.pending
            ? " · Refreshing…"
            : ""}
      </p>
    );
  return (
    <div
      className="mt-2 space-y-1 text-xs leading-5"
      data-total-complete={info.complete}
    >
      <p className="font-semibold">
        {info.pending ? "Refreshing… " : ""}
        {info.complete
          ? "All components available"
          : info.failed || info.pending
            ? "Incomplete · Portfolio or cash unverified"
            : "Incomplete · Missing portfolio or cash"}
      </p>
      <SnapshotAvailability info={info} />
      <p>Source: {info.source}</p>
      {info.capturedAt ? <p title={info.capturedAt}>Snapshot: {dataAge(info.capturedAt)}</p> : null}
      {info.cachedAt !== undefined ? (
        <p>Browser cache: {dataAge(info.cachedAt)} · Saved copy</p>
      ) : null}
    </div>
  );
}
