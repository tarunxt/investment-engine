"use client";

import { useState } from "react";
import type { CardResult, StockInput } from "@/lib/independentScorecards";
import { Grid } from "./ScorecardResultGrid";

export function PairwiseStockScores({ result, stocks = [] }: { result: CardResult; stocks?: StockInput[] }) {
  const [showDetails, setShowDetails] = useState(false);
  const byListing = new Map(result.rows.map(row => [row.listing, row]));
  const listings = [...new Set([...stocks.map(stock => stock.listing), ...byListing.keys()])];
  const rows = listings.map(listing => {
    const row = byListing.get(listing);
    return {
      Listing: listing,
      "Pairwise score /100": row?.score,
      Status: row?.score != null ? row.coverage : row?.expected === 0 ? "No assigned opponents" : "Awaiting judgments",
      Wins: row?.wins,
      Ties: row?.ties,
      Losses: row?.losses,
      Judged: row?.valid,
      Assigned: row?.expected,
    };
  });

  return <section aria-label="Pairwise results" className="space-y-3">
    <div className="flex gap-2" role="group" aria-label="Pairwise score views">
      {["Consolidated scores", "Comparison details"].map((label, index) => {
        const details = index === 1;
        return <button type="button" key={label} aria-pressed={showDetails === details}
          className={showDetails === details ? "rounded bg-teal-800 px-3 py-2 text-white" : "rounded border px-3 py-2"}
          onClick={() => setShowDetails(details)}>{label}</button>;
      })}
    </div>
    {showDetails ? <Grid rows={result.rows}/> : <>
      <p>{rows.length} listings · {rows.filter(row => row["Pairwise score /100"] != null).length} scored</p>
      <Grid rows={rows}/>
    </>}
  </section>;
}
