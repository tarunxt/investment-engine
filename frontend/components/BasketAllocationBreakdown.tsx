import { TradingViewSymbolLink, tradingViewText } from "@/components/shared/TradingViewSymbolLink";
import type { allocateIndiaEquities, BasketScoreHistory, DisplayParameters, workflowFinalMean } from "@/lib/basketDisplayCalculations";

const numeric = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 12 });
const percent = (weight: number) => numeric(100 * weight) + "%";

export function WorkflowMeanCalculation({ history, mean }: {
  history: BasketScoreHistory; mean: ReturnType<typeof workflowFinalMean>;
}) {
  const start = Date.parse(history.window_start);
  const day = 86_400_000;
  const stamp = new Intl.DateTimeFormat("en-IN", { timeZone: history.timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const intervals = Array.from({ length: history.days }, (_, index) => ({
    end: start + (index + 1) * day, observations: [] as typeof mean.rows,
  }));
  for (const row of mean.rows) {
    const index = Math.ceil((Date.parse(row.covered_at) - start) / day) - 1;
    intervals[index]?.observations.push(row);
  }
  return <section aria-label="Workflow mean calculation">
    <h3>Scores in the {history.days}-day window</h3>
    <table><thead><tr><th>24 hours ending ({history.timezone})</th><th>Workflow · recorded at</th><th>Score / 100</th></tr></thead>
      <tbody>{intervals.map(({ end, observations }) => observations.length
        ? observations.slice().sort((a, b) => Date.parse(a.covered_at) - Date.parse(b.covered_at)).map(row =>
          <tr key={row.sequence}><td>{stamp.format(end)}</td><td>#{row.sequence} · {stamp.format(Date.parse(row.covered_at))}</td><td>{numeric(row.score)}</td></tr>)
        : <tr key={end}><td>{stamp.format(end)}</td><td>No saved score</td><td>—</td></tr>)}</tbody>
    </table>
    {mean.score != null && <p><strong>Mean</strong> = ({mean.rows.map(row => numeric(row.score)).join(" + ")}) ÷ {mean.rows.length}
      {" = "}{numeric(mean.sum)} ÷ {mean.rows.length} = <strong>{numeric(mean.score)}</strong> / 100.</p>}
  </section>;
}

type Allocation = ReturnType<typeof allocateIndiaEquities>;
type Venue = Allocation["venues"] extends Map<string, infer T> ? T : never;
export function IndiaWeightCalculation({ allocation, venue, listing, members, parameters, assets }: {
  allocation: Allocation; venue: Venue; listing: string; members: { listing: string; mean: ReturnType<typeof workflowFinalMean> | undefined }[];
  parameters: DisplayParameters; assets: number | null;
}) {
  if (venue.issuerScore == null) return null;
  const rank = allocation.ranks.get(venue.issuer);
  const cutoff = allocation.cutoff;
  const selected = rank != null && rank <= parameters.maximumStocks;
  const investable = 1 - parameters.cash / 100;
  const raw = selected && allocation.denominator > 0 ? venue.issuerScore * investable / allocation.denominator : null;
  return <section aria-label="Target weight calculation">
    <h3>How <TradingViewSymbolLink symbol={listing} /> gets its target weight</h3>
    <p>Each exchange listing contributes one mean to the issuer score for this ISIN.</p>
    <table aria-label="Issuer score sources"><thead><tr><th>Listing</th><th>Saved workflow finals (/100)</th><th>Listing mean (/100)</th></tr></thead>
      <tbody>{members.map(({ listing, mean }) => <tr key={listing}>
        <td><TradingViewSymbolLink symbol={listing} /></td><td>{mean?.rows.map(row => <div key={row.sequence}>#{row.sequence} · {numeric(row.score)}</div>)}</td>
        <td>{mean?.score == null ? "Unavailable" : numeric(mean.score)}</td>
      </tr>)}</tbody>
    </table>
    <p>Issuer score ({venue.issuer}) = ({tradingViewText(members.map(m => m.listing + " " + (m.mean?.score == null ? "unavailable" : numeric(m.mean.score))).join(" + "))})
      {" ÷ "}{members.length} = <strong>{numeric(venue.issuerScore)} / 100</strong>.</p>
    <table><thead><tr><th>Positive-score ranking</th><th>Rank</th><th>Issuer score / 100</th></tr></thead><tbody>
      <tr><td>This issuer</td><td>{rank ? "#" + rank : "Unranked"}</td><td>{numeric(venue.issuerScore)}</td></tr>
      <tr><td>Last selected{cutoff && " · " + cutoff.key}</td><td>{cutoff ? "#" + allocation.ranks.get(cutoff.key) : "—"}</td><td>{cutoff?.score == null ? "—" : numeric(cutoff.score)}</td></tr>
    </tbody></table>
    <p>Up to {parameters.maximumStocks} issuers qualify. {allocation.ranks.size} have positive scores. Equal scores are ordered by ISIN.</p>
    {raw == null ? <p>{rank ? "Rank #" + rank + " falls outside the top " + parameters.maximumStocks : "Only a positive issuer score qualifies"}.
      Target weight = <strong>0%</strong>.</p> : <>
      <p>Investable portfolio = 100% − {numeric(parameters.cash)}% cash = {percent(investable)}.</p>
      <p>Proportional weight = {numeric(venue.issuerScore)} ÷ {numeric(allocation.denominator)} (sum of selected scores) × {percent(investable)} = {percent(raw)}.</p>
      <p>Issuer weight = min({percent(raw)}, {numeric(parameters.normalised)}% effective cap) = <strong>{percent(venue.issuerWeight)}</strong>.</p>
      {members.length > 1 && assets != null && venue.budgetPaise != null
        ? <p>After reserving existing holdings and routing any addition to one exchange, <TradingViewSymbolLink symbol={listing} /> receives ₹{numeric(venue.budgetPaise / 100)}.
          Listing weight = ₹{numeric(venue.budgetPaise / 100)} ÷ ₹{numeric(assets)} × 100 = <strong>{percent(venue.weight)}</strong>.</p>
        : <p>Listing target weight = <strong>{percent(venue.weight)}</strong>.</p>}
    </>}
  </section>;
}
