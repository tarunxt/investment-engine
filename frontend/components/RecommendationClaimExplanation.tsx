/** Additive display metadata; historical records may have no explanation. */
export function ClaimExplanation({ item }: { item: unknown }) {
  if (!item || typeof item !== "object" || !("explanation" in item)) return null;
  const explanation = item.explanation;
  if (!explanation || typeof explanation !== "object" || !("reason" in explanation) || typeof explanation.reason !== "string") return null;
  return <p className="mt-1">{explanation.reason}</p>;
}
