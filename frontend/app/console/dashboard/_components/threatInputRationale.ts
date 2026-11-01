type RationaleSource = {
  id: string;
  source: string;
  label: string;
  jobNo: string;
  status: string;
  error: string | null;
};

/** Describe retained choices without promoting an option to an included input. */
export function threatInputRationale(
  candidates: readonly RationaleSource[],
  selectedIds: ReadonlySet<string>,
  loading: boolean,
  error: string | null,
): string {
  const count = `${selectedIds.size} source${selectedIds.size === 1 ? "" : "s"} selected.`;
  if (loading) return `${count} Checking source availability; choices are retained. Included inputs are not yet verified.`;
  if (error) return `${count} Source availability could not be verified. Reopen this picker to verify inputs before Run; choices are retained.`;
  const selected = candidates.filter(candidate => selectedIds.has(candidate.id));
  const missing = [...selectedIds].filter(id => !candidates.some(candidate => candidate.id === id));
  const parts = [count];
  if (!selectedIds.size) parts.push("No inputs are included. Select a source before Run.");
  for (const candidate of selected) {
    const reference = `${candidate.jobNo} (${candidate.label})`;
    if (candidate.source === "next") {
      parts.push(`Included reservation: ${reference}. This future portfolio snapshot has not been generated; Portfolio Sync must complete before Threat Scan can use it.`);
    } else {
      parts.push(`Included saved source: ${reference}. This is an already-saved snapshot.`);
      if (candidate.error || ["partial", "failed"].includes(candidate.status.toLowerCase())) {
        parts.push(`Source prerequisite: review ${candidate.jobNo} (${candidate.status || "availability unknown"}${candidate.error ? `: ${candidate.error}` : ""}) before Run; complete source data is not confirmed.`);
      }
    }
  }
  if (missing.length) parts.push(`Unmet source prerequisite: ${missing.join(", ")} could not be found among current options. Verify these retained selections before Run.`);
  const available = candidates.filter(candidate => !selectedIds.has(candidate.id));
  if (available.length) parts.push(`Not included: ${available.map(candidate => `${candidate.jobNo} (${candidate.label})`).join("; ")}.`);
  if (!candidates.some(candidate => candidate.source !== "next")) parts.push("No saved snapshot is currently available.");
  return parts.join(" ");
}
