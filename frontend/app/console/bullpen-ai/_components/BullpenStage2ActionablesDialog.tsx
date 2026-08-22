"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";

import type {
  BullpenStage2ActionableItem,
  BullpenStage2ActionablesView,
} from "./bullpenStage2Actionables";

type ActionableSectionTone = "exit" | "buy" | "hold";

const SECTION_CLASSES: Record<
  ActionableSectionTone,
  {
    container: string;
    header: string;
    badge: string;
    row: string;
    empty: string;
  }
> = {
  exit: {
    container: "border-rose-200 bg-rose-50/80",
    header: "text-rose-800",
    badge: "border-rose-200 bg-white text-rose-800",
    row: "border-rose-100 bg-white/90",
    empty: "border-rose-200 bg-white/70 text-rose-800",
  },
  buy: {
    container: "border-emerald-200 bg-emerald-50/80",
    header: "text-emerald-800",
    badge: "border-emerald-200 bg-white text-emerald-800",
    row: "border-emerald-100 bg-white/90",
    empty: "border-emerald-200 bg-white/70 text-emerald-800",
  },
  hold: {
    container: "border-amber-200 bg-amber-50/85",
    header: "text-amber-900",
    badge: "border-amber-200 bg-white text-amber-900",
    row: "border-amber-100 bg-white/90",
    empty: "border-amber-200 bg-white/70 text-amber-900",
  },
};

function formatMoney(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return `$${value.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function formatOdds(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function ActionableRow({ item }: { item: BullpenStage2ActionableItem }) {
  const currentExposure = formatMoney(item.currentExposureUsd);
  const targetExposure = formatMoney(item.targetExposureUsd);
  const llmYesOdds = formatOdds(item.llmYesOdds);
  const llmNoOdds = formatOdds(item.llmNoOdds);

  return (
    <article className="rounded-xl border border-inherit bg-white/90 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h4 className="font-semibold leading-5 text-slate-950">
              {item.marketUrl ? (
                <a
                  href={item.marketUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-start gap-1.5 hover:text-sky-700 hover:underline"
                >
                  <span>{item.title}</span>
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                </a>
              ) : (
                item.title
              )}
            </h4>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600">{item.reason}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
          {item.rank !== null ? (
            <span className="rounded-full border border-slate-200 bg-white px-2 py-1">
              Rank #{item.rank}
            </span>
          ) : null}
          {item.side ? (
            <span className="rounded-full border border-slate-200 bg-white px-2 py-1">
              {item.side}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
        {item.theme ? <span>Theme: {item.theme}</span> : null}
        {currentExposure ? <span>Current: {currentExposure}</span> : null}
        {targetExposure ? <span>Target: {targetExposure}</span> : null}
        {llmYesOdds ? <span>LLM Yes: {llmYesOdds}</span> : null}
        {llmNoOdds ? <span>LLM No: {llmNoOdds}</span> : null}
        {item.returnsPerDay !== null ? (
          <span>
            Returns/day: {item.returnsPerDay.toLocaleString("en-IN", {
              maximumFractionDigits: 2,
            })}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function ActionableSection({
  title,
  description,
  items,
  tone,
  emptyMessage,
}: {
  title: string;
  description: string;
  items: BullpenStage2ActionableItem[];
  tone: ActionableSectionTone;
  emptyMessage: string;
}) {
  const classes = SECTION_CLASSES[tone];

  return (
    <section className={`rounded-2xl border p-4 ${classes.container}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className={`text-sm font-bold uppercase tracking-[0.16em] ${classes.header}`}>
            {title}
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">{description}</p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-bold tabular-nums ${classes.badge}`}
        >
          {items.length}
        </span>
      </div>

      {items.length > 0 ? (
        <div className={`mt-3 space-y-2 ${classes.row}`}>
          {items.map((item) => (
            <ActionableRow key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <div className={`mt-3 rounded-xl border px-4 py-4 text-sm ${classes.empty}`}>
          {emptyMessage}
        </div>
      )}
    </section>
  );
}

export function BullpenStage2ActionablesDialog({
  actionables,
  onClose,
}: {
  actionables: BullpenStage2ActionablesView;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [marketMetadata, setMarketMetadata] = useState<
    Record<
      string,
      { title: string | null; marketUrl: string | null; slug: string | null }
    >
  >({});

  const unresolvedMarketIds = useMemo(
    () =>
      actionables.eventExits
        .filter(
          (item) =>
            item.marketId &&
            item.title === item.marketId &&
            !item.marketUrl,
        )
        .map((item) => item.marketId as string),
    [actionables.eventExits],
  );

  useEffect(() => {
    if (unresolvedMarketIds.length === 0) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/bullpen-ai/market-urls", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({
            questions: unresolvedMarketIds.map((id) => ({
              id,
              slug: null,
              marketUrl: null,
              question: null,
              category: null,
            })),
          }),
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          marketTitles?: Record<string, string | null>;
          marketUrls?: Record<string, string | null>;
          marketSlugs?: Record<string, string | null>;
        };
        if (controller.signal.aborted) return;
        setMarketMetadata(
          Object.fromEntries(
            unresolvedMarketIds.map((id) => [
              id,
              {
                title: payload.marketTitles?.[id] ?? null,
                marketUrl: payload.marketUrls?.[id] ?? null,
                slug: payload.marketSlugs?.[id] ?? null,
              },
            ]),
          ),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Unable to enrich persisted Stage 2 actionables", error);
        }
      }
    })();

    return () => controller.abort();
  }, [unresolvedMarketIds]);

  const visibleActionables = useMemo(() => {
    const eventExits = actionables.eventExits.map((item) => {
      if (!item.marketId) return item;
      const metadata = marketMetadata[item.marketId];
      if (!metadata?.title) return item;
      return {
        ...item,
        title: metadata.title,
        marketUrl: metadata.marketUrl,
        slug: metadata.slug,
        reason:
          "Persisted by Stage 2 as an authoritative Event Exit actionable.",
      };
    });
    const exitKeys = new Set(
      eventExits.flatMap((item) =>
        [item.title, item.slug, item.marketUrl]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim().toLowerCase()),
      ),
    );
    const hold = actionables.hold.filter(
      (item) =>
        ![item.title, item.slug, item.marketUrl]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim().toLowerCase())
          .some((value) => exitKeys.has(value)),
    );
    return { ...actionables, eventExits, hold };
  }, [actionables, marketMetadata]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/65 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="bullpen-stage2-actionables-dialog"
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Latest Stage 2 LLM result
            </p>
            <h2 id={titleId} className="mt-2 text-xl font-semibold text-slate-950">
              Actionables
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Exit {visibleActionables.eventExits.length} · Buy {visibleActionables.buyNew.length} · Hold{" "}
              {visibleActionables.hold.length}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 2 actionables"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <ActionableSection
            title="Event Exits"
            description="Active Bullpen positions identified for sale or displaced from the LLM-selected portfolio."
            items={visibleActionables.eventExits}
            tone="exit"
            emptyMessage="No active Bullpen position is currently identified for exit."
          />
          <ActionableSection
            title="Buy New"
            description="New events selected by the latest LLM ranking for a potential Bullpen purchase."
            items={visibleActionables.buyNew}
            tone="buy"
            emptyMessage="No new Bullpen event is currently identified for purchase."
          />
          <ActionableSection
            title="Hold"
            description="Active Bullpen positions not included in Event Exits and therefore retained for now."
            items={visibleActionables.hold}
            tone="hold"
            emptyMessage="No active Bullpen position is currently classified as Hold."
          />
        </div>
      </div>
    </div>
  );
}
