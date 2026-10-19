"use client";

import { useState } from "react";

export default function Uat2Page() {
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  async function inspect(path: string) {
    setLoading(true);
    try {
      const response = await fetch(`/backend-api/${path}`, { cache: "no-store" });
      const value = await response.json();
      setResult(JSON.stringify(value, null, 2));
    } catch {
      setResult("Preview request failed. Retry after checking UAT2 service status.");
    } finally { setLoading(false); }
  }
  if (process.env.NEXT_PUBLIC_UAT2 !== "true") return null;
  return (
    <section className="space-y-5 p-6">
      <h1 className="text-2xl font-semibold">UAT2 simulation walkthrough</h1>
      <p>Sign in with the approved owner Google account after passing the independent access barrier.
        This is the actual CredX console using synthetic data and isolated test adapters.</p>
      <nav className="flex gap-4 underline">
        <a href="/console/dashboard">Dashboard</a><a href="/console/profile">Profile and preferences</a>
        <a href="/console/zerodha">India portfolio</a><a href="/console/indmoney-us">US portfolio</a>
      </nav>
      <p>Broker orders are simulated. AI results are deterministic and cost zero. Email is captured locally.
        Live integrations, Sheets, sports/Bullpen workflows and scheduled jobs are unavailable.
        Stage01 module controls are pending integration of its tested source commit.</p>
      <p>Empty/populated fixtures are selected by the operator using the documented reset command.
        WebSockets are disabled; supported screens use polling.</p>
      <div className="flex gap-3">
        <button className="rounded border px-3 py-2" disabled={loading} onClick={() => inspect("uat2/status")}>Inspect simulation status</button>
        <button className="rounded border px-3 py-2" disabled={loading} onClick={() => inspect("uat2/unavailable-module")}>Review unavailable state</button>
      </div>
      <p role="status">{loading ? "Loading UAT2 response…" : ""}</p>
      {result && <pre className="overflow-auto rounded bg-muted p-4 text-xs">{result}</pre>}
    </section>
  );
}
