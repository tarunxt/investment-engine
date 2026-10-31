export type TotalDataStatusInfo = {
  source: string;
  capturedAt?: string | null;
  cachedAt?: number;
  pending?: boolean;
  failed?: boolean;
  complete: boolean;
};

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
        Source: {info.source} · Snapshot {dataAge(info.capturedAt)}
        {info.cachedAt === undefined
          ? ""
          : ` · Browser cache ${dataAge(info.cachedAt)}`}
        {info.failed
          ? " · Refresh failed"
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
          : "Incomplete · Missing portfolio or cash"}
      </p>
      {info.failed ? <p className="font-semibold">Refresh failed · {info.capturedAt ? "Last available data" : "No snapshot available"}</p> : null}
      <p>Source: {info.source}</p>
      <p title={info.capturedAt ?? undefined}>
        Snapshot: {dataAge(info.capturedAt)}
      </p>
      {info.cachedAt !== undefined ? (
        <p>Browser cache: {dataAge(info.cachedAt)} · Saved copy</p>
      ) : null}
    </div>
  );
}
