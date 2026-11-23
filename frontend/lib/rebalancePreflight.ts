export type PreflightCheck = { label: string; run: () => Promise<unknown> };

export function parseWorkflowSpendLimit(input: string): number | undefined {
  const value = input.trim();
  if (value === "") return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 100000) {
    throw new Error("Enter a run spending limit from ₹0 to ₹100,000 with up to two decimal places.");
  }
  return Number(value);
}

/** Read-only checks collect every independent failure before any stage is launched. */
export async function collectPreflightErrors(checks: PreflightCheck[]): Promise<string[]> {
  const results = await Promise.allSettled(checks.map(check => Promise.resolve().then(check.run)));
  return results.flatMap((result, index) => result.status === "rejected"
    ? [`${checks[index].label} — ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : []);
}
