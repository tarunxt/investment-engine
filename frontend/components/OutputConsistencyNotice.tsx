type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function conflictText(check: RecordValue): string | null {
  const evidence = check.evidence;
  if (!record(evidence) || typeof evidence.statement !== "string") return null;
  if (check.code === "supplied_price_comparison_contradiction" && typeof evidence.supplied_price === "string") {
    return `“${evidence.statement}” conflicts with this row's supplied Price per Unit (${evidence.supplied_price}).`;
  }
  if (["referenced_source_identity_mismatch", "referenced_run_identity_mismatch"].includes(String(check.code))
    && typeof evidence.exchange_symbol === "string" && typeof evidence.stock_symbol === "string") {
    return `“${evidence.statement}” has no ${evidence.exchange_symbol}:${evidence.stock_symbol} row in the complete saved source evidence.`;
  }
  return null;
}

/** Advisory only: leaves the saved output, actions and contract status intact. */
export function OutputConsistencyNotice({ metadata }: { metadata?: unknown }) {
  if (!record(metadata) || !record(metadata.deterministic_output)) return null;
  const report = metadata.deterministic_output.consistency;
  if (!record(report)) return null; // Legacy output was never checked.
  const counts = report.check_counts;
  if (report.version !== "credx-output-consistency-v1" || !record(counts)) {
    return <aside className="mb-4 rounded border border-slate-200 p-3 text-sm">Output consistency report unavailable.</aside>;
  }
  const values = ["consistent", "inconsistent", "unknown", "unchecked"].map((key) => count(counts[key]));
  if (values.some((value) => value === null)) {
    return <aside className="mb-4 rounded border border-slate-200 p-3 text-sm">Output consistency report unavailable.</aside>;
  }
  const [consistent, conflicts, unknown, unchecked] = values as number[];
  const omitted = record(report.omitted_check_counts) ? report.omitted_check_counts : {};
  const omittedDetails = Object.values(omitted).reduce<number>((total, value) => total + (count(value) ?? 0), 0);
  const omittedConflicts = count(omitted.inconsistent) ?? 0;
  const findings = Array.isArray(report.checks) ? report.checks.filter(record).filter((check) => check.status === "inconsistent") : [];
  return (
    <aside aria-label="Output consistency advisory" className={`mb-4 rounded border p-3 text-sm ${conflicts ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
      <p className="font-semibold">{conflicts ? `${conflicts} supplied-evidence conflict${conflicts === 1 ? "" : "s"}`
        : consistent ? `No conflicts found in ${consistent} supported checks` : "Output consistency unverified"}</p>
      <p className="mt-1">{unknown} checks remain unknown; {unchecked} statements are unchecked. These checks compare saved source rows and supplied row prices. Live prices and investment advice were not evaluated.</p>
      {report.detail_limit_reached === true ? <p className="mt-1">{omittedDetails} check details are omitted, including {omittedConflicts} conflict{omittedConflicts === 1 ? "" : "s"}. All are included in the counts above.</p> : null}
      {findings.length ? <details className="mt-2">
        <summary className="cursor-pointer font-medium">View recorded conflicts</summary>
        <ul className="mt-2 space-y-2">
          {findings.map((finding, index) => {
            const text = conflictText(finding);
            const source = record(finding.source) ? finding.source : {};
            return text ? <li key={index}>
              {count(source.row) !== null ? `Row ${source.row}${count(source.fragment) !== null ? ` (fragment ${source.fragment})` : ""}: ` : ""}{text}
            </li> : null;
          })}
        </ul>
      </details> : null}
    </aside>
  );
}
