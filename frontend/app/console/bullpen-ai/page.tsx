"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { URLs } from "@/lib/urls";

type ScanMode = "30-days" | "end-of-month";
type BullpenQuestion = {
  id: string;
  question: string;
  closeTime: string | null;
  category: string;
  yesOdds: number | null;
  noOdds: number | null;
  volume: string | null;
  liquidity: string | null;
  sourceUrl: string;
};

const LIMIT_PRESETS = [25, 100, 250, 500] as const;

type ScanResult = {
  mode: ScanMode;
  sourceUrl: string;
  limit: number;
  scannedAt: string;
  questions: BullpenQuestion[];
  error?: string;
  warning?: string;
};

const TABS: { mode: ScanMode; label: string; href: string; description: string }[] = [
  {
    mode: "30-days",
    label: "30 days",
    href: URLs.routes.console.bullpenAi30Days(),
    description: "Trending Bullpen Yes/No questions closing in under 30 days, excluding sports, weather, markets, and crypto.",
  },
  {
    mode: "end-of-month",
    label: "End of Month",
    href: URLs.routes.console.bullpenAiEndOfMonth(),
    description: "Calendar Bullpen Yes/No questions ending exactly on June 30, 2026 with eligible two-sided odds.",
  },
];

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}x`;
}

export default function BullpenAiPage() {
  const searchParams = useSearchParams();
  const activeMode: ScanMode = searchParams.get("tab") === "end-of-month" ? "end-of-month" : "30-days";
  const activeTab = TABS.find((tab) => tab.mode === activeMode) || TABS[0];
  const [limit, setLimit] = useState(100);
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredResult = useMemo(() => (result?.mode === activeMode ? result : null), [activeMode, result]);

  async function runScan(scanLimit = limit) {
    setIsScanning(true);
    setError(null);
    try {
      const response = await fetch(`/api/bullpen-ai?mode=${activeMode}&limit=${scanLimit}`, { cache: "no-store" });
      const payload = (await response.json()) as ScanResult;
      setResult(payload);
      setLimit(payload.limit || scanLimit);
      if (!response.ok || payload.error) setError(payload.error || "Bullpen scan failed.");
      else if (payload.warning) setError(payload.warning);
      else if (payload.questions.length === 0) {
        setError("No eligible Bullpen questions matched the current scan filters. Try a higher limit or rerun the scan later");
      }
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Bullpen scan failed.");
    } finally {
      setIsScanning(false);
    }
  }

  function chooseLimit(nextLimit: number) {
    if (isScanning) return;
    setLimit(nextLimit);
    void runScan(nextLimit);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">Copy Trading Bots</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Bullpen x AI</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Run focused Bullpen scans for binary Yes/No prediction questions with odds greater than 5x in both directions.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.mode}
            href={tab.href}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeMode === tab.mode ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="gap-2">
          <CardTitle>{activeTab.label} Bullpen Scan</CardTitle>
          <CardDescription>{activeTab.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-64 space-y-2">
              <Label htmlFor="bullpen-limit">Question limit</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="bullpen-limit"
                  type="number"
                  min={1}
                  max={500}
                  value={limit}
                  onChange={(event) => setLimit(Math.min(Math.max(Number(event.target.value) || 100, 1), 500))}
                  className="w-28"
                />
                <div className="flex flex-wrap gap-1.5" aria-label="Question limit presets">
                  {LIMIT_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      variant={limit === preset ? "default" : "outline"}
                      size="sm"
                      onClick={() => chooseLimit(preset)}
                      disabled={isScanning}
                      className="h-9 px-3 text-xs"
                    >
                      {preset}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="text-xs leading-relaxed text-slate-500">
                Choose a preset to scan immediately, or enter a custom limit and click Run Bullpen Scan. Higher limits scan broader, but may take longer.
              </p>
            </div>
            <Button onClick={() => runScan()} disabled={isScanning} className="gap-2 whitespace-nowrap">
              {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Run Bullpen Scan
            </Button>
            <a href={filteredResult?.sourceUrl || (activeMode === "end-of-month" ? "https://app.bullpen.fi/predictions/trending?primaryMode=calendar&ref=intrepid-crane-3" : "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-purple-700 hover:text-purple-900">
              Open source <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          {error ? (
            <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}. If Bullpen blocks server-side access, rerun after network access/session availability is restored.</p>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Question</th>
                    <th className="px-4 py-3">Closing time</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Yes odds</th>
                    <th className="px-4 py-3">No odds</th>
                    <th className="px-4 py-3">Volume</th>
                    <th className="px-4 py-3">Liquidity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredResult?.questions.length ? filteredResult.questions.map((question) => (
                    <tr key={question.id} className="hover:bg-slate-50">
                      <td className="max-w-xl px-4 py-3 font-medium text-slate-900">{question.question}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(question.closeTime)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{question.category}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-emerald-700">{formatOdds(question.yesOdds)}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-rose-700">{formatOdds(question.noOdds)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{question.volume || "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{question.liquidity || "—"}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                        {isScanning ? "Scanning Bullpen..." : "No scan results yet. Choose a preset to scan immediately, or enter a custom limit and click Run Bullpen Scan."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
