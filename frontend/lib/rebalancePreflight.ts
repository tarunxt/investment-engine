export type PreflightCheck = { label: string; run: () => Promise<unknown> };

/** Read-only checks collect every independent failure before any stage is launched. */
export async function collectPreflightErrors(checks: PreflightCheck[]): Promise<string[]> {
  const results = await Promise.allSettled(checks.map(check => Promise.resolve().then(check.run)));
  return results.flatMap((result, index) => result.status === "rejected"
    ? [`${checks[index].label} — ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : []);
}
