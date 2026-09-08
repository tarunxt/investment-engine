export type ClusterAssignment = { event_name: string; market_id: string; cluster_id: string };
export type ClusterMode = 0 | 1 | 2;

// A changed published mapping invalidates old browser overrides without deleting them.
export function loadClusterOverrides(published: ClusterAssignment[], stored: string | null): ClusterAssignment[] {
  if (!stored) return published;
  const snapshot = JSON.parse(stored);
  if (snapshot?.revision !== JSON.stringify(published)) return published;
  return parseClusterJson(JSON.stringify(snapshot.rows));
}
type ClusterEvent = {
  market_id: string; market_title: string; returns_per_day?: number | null;
  current_yes_odds?: number | null; current_no_odds?: number | null;
};

export function normalizeClusterId(value: unknown): string {
  if (typeof value !== "string" || !/^C\d+$/i.test(value.trim())) throw new Error("Use a Cluster ID such as C01, C02 or C03.");
  const digits = value.trim().slice(1).replace(/^0+/, "");
  if (!digits || digits.length > 6) throw new Error("Cluster IDs must be between C01 and C999999.");
  return `C${digits.padStart(2, "0")}`;
}

export function parseClusterJson(text: string): ClusterAssignment[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Invalid JSON. Paste an array of events with event_name, market_id and cluster_id."); }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "events" in parsed ? parsed.events : null;
  if (!Array.isArray(rows)) throw new Error("Expected a JSON array, or an object containing an events array.");
  if (rows.length > 20000) throw new Error("Import at most 20,000 events at a time.");
  const assignments = new Map<string, ClusterAssignment>();
  rows.forEach((row: unknown, index: number) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Row ${index + 1}: expected an event object.`);
    const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[ _-]/g, "").toLowerCase(), value]));
    const name = fields.eventname ?? fields.markettitle;
    const market = fields.marketid;
    if (typeof name !== "string" || !name.trim()) throw new Error(`Row ${index + 1}: event_name is required.`);
    if (!(typeof market === "string" && market.trim()) && !(typeof market === "number" && Number.isSafeInteger(market) && market > 0)) throw new Error(`Row ${index + 1}: a valid market_id is required.`);
    let cluster: string;
    try { cluster = normalizeClusterId(fields.clusterid); } catch (error) { throw new Error(`Row ${index + 1}: ${(error as Error).message}`); }
    const id = String(market).trim();
    const previous = assignments.get(id);
    if (previous && previous.cluster_id !== cluster) throw new Error(`Row ${index + 1}: market ${id} has conflicting Cluster IDs.`);
    assignments.set(id, { event_name: name.trim(), market_id: id, cluster_id: cluster });
  });
  return [...assignments.values()];
}

export const hasValidClusterCurrentOdds = (event: ClusterEvent) =>
  [event.current_yes_odds, event.current_no_odds].some(value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100);

export function arrangeClusterEvents<T extends ClusterEvent>(events: T[], clusters: ReadonlyMap<string, string>, mode: ClusterMode): T[] {
  if (mode === 0) return events;
  const groups = new Map<string, T[]>();
  for (const event of events) {
    const cluster = clusters.get(event.market_id);
    if (!cluster || !hasValidClusterCurrentOdds(event) || typeof event.returns_per_day !== "number" || !Number.isFinite(event.returns_per_day)) continue;
    const group = groups.get(cluster) ?? [];
    group.push(event);
    groups.set(cluster, group);
  }
  const compare = (a: T, b: T) => b.returns_per_day! - a.returns_per_day! || a.market_id.localeCompare(b.market_id);
  const ranked = [...groups.entries()].map(([id, group]) => ({ id, group: group.sort(compare) }))
    .sort((a, b) => b.group[0].returns_per_day! - a.group[0].returns_per_day! || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return ranked.flatMap(({ group }) => mode === 2 ? [group[0]] : group);
}
