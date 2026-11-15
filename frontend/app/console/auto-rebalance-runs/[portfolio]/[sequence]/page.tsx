"use client";

import { useParams } from "next/navigation";

import {
  AutoRebalanceHistoryDetailClient,
  type AutoRebalanceHistoryPortfolio,
} from "../../_components/AutoRebalanceHistoryClient";

export default function AutoRebalanceRunDetailPage() {
  const params = useParams<{ portfolio: string; sequence: string }>();
  const portfolio: AutoRebalanceHistoryPortfolio =
    params.portfolio === "indmoneyUs" ? "indmoneyUs" : "zerodha";
  const sequence = Number.parseInt(params.sequence, 10);
  return <AutoRebalanceHistoryDetailClient portfolio={portfolio} sequence={Number.isFinite(sequence) ? sequence : 0} />;
}
