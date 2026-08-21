"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Info, ShieldAlert, Wallet, X, Zap } from "lucide-react";

function StrategyCard({
  title,
  badge,
  tone,
  icon,
  description,
  bullets,
}: {
  title: string;
  badge?: string;
  tone: "amber" | "red" | "blue" | "slate";
  icon: ReactNode;
  description: string;
  bullets: string[];
}) {
  const toneClasses =
    tone === "amber"
      ? {
          container: "border-amber-200 bg-amber-50/90",
          border: "border-amber-500",
          badge: "bg-amber-100 text-amber-900",
          text: "text-amber-950",
          muted: "text-amber-900/85",
        }
      : tone === "red"
        ? {
            container: "border-rose-200 bg-rose-50/90",
            border: "border-rose-500",
            badge: "bg-rose-100 text-rose-900",
            text: "text-rose-950",
            muted: "text-rose-900/85",
          }
        : tone === "blue"
          ? {
              container: "border-sky-200 bg-sky-50/90",
              border: "border-sky-500",
              badge: "bg-sky-100 text-sky-900",
              text: "text-sky-950",
              muted: "text-sky-900/85",
            }
          : {
              container: "border-slate-200 bg-slate-50/90",
              border: "border-slate-400",
              badge: "bg-slate-200 text-slate-900",
              text: "text-slate-950",
              muted: "text-slate-700",
            };

  return (
    <section className={`rounded-2xl border ${toneClasses.container}`}>
      <div className={`border-l-4 ${toneClasses.border} px-4 py-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 ${toneClasses.text}`}>{icon}</span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={`text-sm font-semibold ${toneClasses.text}`}>{title}</h3>
                {badge ? (
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}>
                    {badge}
                  </span>
                ) : null}
              </div>
              <p className={`mt-2 text-sm leading-6 ${toneClasses.muted}`}>{description}</p>
            </div>
          </div>
        </div>
        <div className="mt-4 grid gap-2">
          {bullets.map((bullet) => (
            <div
              key={bullet}
              className="rounded-xl border border-white/80 bg-white/70 px-3 py-2 text-xs leading-5 text-slate-700"
            >
              {bullet}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BullpenEventExitStrategiesDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[135] flex items-center justify-center bg-slate-950/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 shadow-[0_32px_90px_-32px_rgba(15,23,42,0.8)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Stage 3 Reference
            </p>
            <h2 className="text-xl font-semibold text-white">
              Event Exit Strategies
            </h2>
            <p className="max-w-2xl text-sm text-slate-300">
              Step 1 combines the original ranking and LLM exit logic with the new capital-aware forced-exit safety layer.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 text-slate-300 transition hover:bg-slate-900 hover:text-white"
            aria-label="Close Event Exit Strategies"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-4">
            <StrategyCard
              title="Strategy 1: LLM + Returns/day Exit"
              badge="Current strategy"
              tone="amber"
              icon={<Info className="h-4 w-4" />}
              description="Sells active Bullpen positions that fall outside the top 10 by Returns/day or no longer pass the LLM / odds filters."
              bullets={[
                "Position is outside top 10 by Returns/day",
                "LLM review no longer supports the held side",
                "Odds filter no longer qualifies the event",
                "Moved from Active Bullpen Positions to Event Exits when it should be sold to free capital.",
              ]}
            />

            <StrategyCard
              title="Strategy 2: Capital-Aware Forced Exit"
              badge="New safety exit"
              tone="red"
              icon={<ShieldAlert className="h-4 w-4" />}
              description="Detects positions that are virtually lost or rapidly moving against the held outcome, then exits them before they keep capital stuck."
              bullets={[
                "Market is 99.5% or more against the held outcome",
                "Market is 99% against us for 2 confirmed snapshots",
                "Held-side best bid falls below 0.5c",
                "Held side drops 15 percentage points in 1 minute while market is at least 85% against us",
                "Held side drops 25 percentage points in 5 minutes while market is at least 80% against us",
                "Moved immediately to Event Exits and processed before new investments.",
              ]}
            />

            <StrategyCard
              title="Refresh Cadence"
              tone="blue"
              icon={<Zap className="h-4 w-4" />}
              description="Active positions refresh odds every 15 seconds. WATCH_FAST positions refresh every 5 seconds. LLM is not called on every odds tick."
              bullets={[
                "Stage 3 already evaluates forced exits during the existing worker run.",
                "TODO hook: dedicated 15s / 5s active-odds refresh can layer on top without turning every tick into an LLM run.",
              ]}
            />

            <StrategyCard
              title="Capital Accounting"
              tone="slate"
              icon={<Wallet className="h-4 w-4" />}
              description="Exit value uses executable held-side bid x shares, not original average entry price. Positions with no meaningful bid are marked as dust so they do not block new investment capacity forever."
              bullets={[
                "Freeable value comes from executable held-side bid x shares",
                "Original average entry price is not reused for exit capital planning",
                "Dust / no-bid positions stay out of the active capital loop instead of getting stuck forever",
              ]}
            />
          </div>

          <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-xs leading-5 text-slate-300">
            <div className="flex items-center gap-2 font-semibold text-white">
              <AlertTriangle className="h-4 w-4 text-amber-300" />
              Badge guide
            </div>
            <p className="mt-2">
              Event Exits can show multiple reason badges at once, so a single position can be both
              {" "}
              &quot;Outside Top 10&quot;
              {" "}
              and
              {" "}
              &quot;99.5% Against Us&quot;
              {" "}
              without being duplicated in the exit list.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
