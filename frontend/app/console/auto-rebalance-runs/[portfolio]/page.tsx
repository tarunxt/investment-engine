"use client";

import { useParams } from "next/navigation";

import {
  AutoRebalanceHistoryListClient,
  type AutoRebalanceHistoryPortfolio,
} from "../_components/AutoRebalanceHistoryClient";

export default function AutoRebalanceRunsPage() {
  const params = useParams<{ portfolio: string }>();
  const portfolio: AutoRebalanceHistoryPortfolio =
    params.portfolio === "indmoneyUs" ? "indmoneyUs" : "zerodha";
  return <AutoRebalanceHistoryListClient portfolio={portfolio} />;
}
