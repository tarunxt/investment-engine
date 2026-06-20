import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { URLs } from "@/lib/urls";

const AUTO_LIVE_GUARDRAILS = [
  "Max single trade",
  "Max market exposure",
  "Max theme exposure",
  "Max open exposure",
  "Cash reserve",
  "Min edge",
  "Max LLM disagreement",
  "Evidence requirement",
  "Daily/weekly loss stop",
  "Limit orders only",
  "Emergency stop status",
];

export default function BullpenAiAutoLivePage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-8">
      <div className="space-y-3">
        <div className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Trading Bots
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">
            Bullpen AI Auto-Live
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            This console page is live in navigation now and ready for backend wiring. Existing bot pages remain unchanged, while Auto-Live gets its own destination for future execution controls and telemetry.
          </p>
        </div>
      </div>

      <Card className="gap-0 rounded-[28px] border border-slate-200 bg-white py-0 shadow-sm">
        <CardHeader className="gap-3 border-b border-slate-100 px-6 py-6 sm:px-7">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
              Not configured
            </span>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-800">
              Dry-run
            </span>
          </div>
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">
            Strategy
          </CardTitle>
          <CardDescription className="max-w-4xl text-sm text-slate-600">
            Fully automated AI + evidence + market-rules based Bullpen trading engine. Scans markets, parses rules, builds shared evidence, runs LLM consensus, scores edges, sizes positions, rebalances active positions, and executes live limit orders only when all guardrails pass.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 px-6 py-6 sm:px-7 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                What lands here next
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                This page is intentionally lightweight for now. It gives the new sidebar destination a stable URL and a clean shell for future live settings, run history, exposure controls, and emergency-stop telemetry.
              </p>
            </div>
            <div className="rounded-2xl border border-rose-100 bg-rose-50/60 px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
                Primary risk warning
              </p>
              <p className="mt-2 text-sm leading-6 text-rose-800">
                Full automation can amplify model error, stale evidence, and liquidity slippage quickly, so the live version should only execute when every capital, evidence, and emergency-stop guardrail is explicitly green.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                asChild
                size="sm"
                className="rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
              >
                <Link href={URLs.routes.console.tradingBots()}>
                  Open Trading Bots Overview
                </Link>
              </Button>
              <Button
                asChild
                size="sm"
                variant="outline"
                className="rounded-full border-slate-300 px-5"
              >
                <Link href={URLs.routes.console.bullpenAi()}>
                  Open Bullpen x AI
                </Link>
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Guardrails scaffold
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {AUTO_LIVE_GUARDRAILS.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

