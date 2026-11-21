"use client";

import { useEffect, useState } from "react";
import { referenceCostQuote } from "@/lib/rebalanceCost";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";

type Quote = typeof referenceCostQuote;
const cacheKey = "rebalance-cost-usd-inr-v1";
let pending: Promise<Quote> | undefined;
let refreshAfter = 0;

function usable(quote: Quote | null): quote is Quote {
  return !!quote && quote.source === "Frankfurter" && Number.isFinite(quote.rate)
    && quote.rate >= 20 && quote.rate <= 200 && /^\d{4}-\d{2}-\d{2}$/.test(quote.date)
    && Number.isFinite(Date.parse(quote.date)) && quote.date > referenceCostQuote.date
    && quote.date <= new Date().toISOString().slice(0, 10);
}

function savedQuote(): Quote {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
    if (usable(cached)) return cached;
  } catch { /* Storage can be disabled. */ }
  return referenceCostQuote;
}

async function fetchReferenceQuote() {
  const previous = savedQuote();
  try {
    const response = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR", {
      credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return previous;
    const data = await response.json();
    const next = { rate: data.rates?.INR, date: data.date, source: "Frankfurter" };
    if (data.base !== "USD" || !usable(next) || next.date < previous.date) return previous;
    try { localStorage.setItem(cacheKey, JSON.stringify(next)); } catch { /* Optional cache. */ }
    return next;
  } catch { return previous; }
}

export function useRebalanceCostQuote() {
  const verifiedRate = useUsdInrRate();
  const [reference, setReference] = useState(referenceCostQuote);
  useEffect(() => {
    if (verifiedRate > 0) return;
    let active = true;
    function refresh() {
      setReference(savedQuote());
      if (!pending || Date.now() >= refreshAfter) {
        refreshAfter = Date.now() + 60 * 60 * 1000;
        pending = fetchReferenceQuote();
      }
      void pending.then(quote => { if (active) setReference(quote); });
    }
    refresh();
    const interval = window.setInterval(refresh, 60 * 60 * 1000);
    return () => { active = false; window.clearInterval(interval); };
  }, [verifiedRate]);
  const rate = verifiedRate || reference.rate;
  const label = verifiedRate ? "Verified USD/INR rate" : `${reference.source} · ${reference.date}`;
  return { rate, verifiedRate, label: `${label} · ₹${rate.toFixed(4)} per US$1` };
}
