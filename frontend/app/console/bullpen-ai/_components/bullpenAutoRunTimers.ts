export function formatElapsedRunTime(startedAt: string | null, nowMs: number) {
  if (!startedAt) return "0:00";

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return "0:00";

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const paddedMinutes = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const paddedSeconds = String(seconds).padStart(2, "0");

  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

export function formatStageElapsedTime(
  startedAt: string | null,
  completedAt: string | null,
  nowMs: number,
) {
  if (!startedAt) return "Not started";

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return "Timer unavailable";

  const completedAtMs = completedAt ? Date.parse(completedAt) : null;
  const hasCompletedAt = completedAtMs !== null && !Number.isNaN(completedAtMs);
  const endMs = hasCompletedAt ? completedAtMs : nowMs;
  const safeEndMs = Math.max(startedAtMs, endMs);
  const elapsedMs = safeEndMs - startedAtMs;

  if (elapsedMs < 1_000) {
    return hasCompletedAt ? "0:01" : "<0:01";
  }

  return formatElapsedRunTime(startedAt, safeEndMs);
}
