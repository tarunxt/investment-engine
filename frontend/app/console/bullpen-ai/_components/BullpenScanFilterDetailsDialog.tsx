"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BULLPEN_SCAN_FILTER_DETAILS,
  type BullpenScanFilterDetailId,
} from "@/lib/bullpenScanExclusions";

type BullpenScanFilterDetailsDialogProps = {
  detailId: BullpenScanFilterDetailId;
  customKeywords: string[];
  onSaveCustomKeywords: (keywords: string[]) => void;
  onClose: () => void;
};

function normalizeKeyword(value: string) {
  return value.trim().toLowerCase();
}

function DetailList({
  title,
  items,
  monospace = false,
}: {
  title: string;
  items: string[];
  monospace?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item}
            className={`rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700 ${monospace ? "font-mono text-xs leading-5" : ""}`}
          >
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}

export function BullpenScanFilterDetailsDialog({
  detailId,
  customKeywords,
  onSaveCustomKeywords,
  onClose,
}: BullpenScanFilterDetailsDialogProps) {
  const detail = BULLPEN_SCAN_FILTER_DETAILS[detailId];
  const algorithmTitle =
    detailId === "onlyBinaryYesNo"
      ? "Exact keep algorithm"
      : "Exact exclusion algorithm";
  const supportsCustomKeywords = detailId !== "onlyBinaryYesNo";
  const [draftKeywords, setDraftKeywords] = useState<string[]>(customKeywords);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const hasUnsavedChanges = useMemo(
    () => draftKeywords.join(",") !== customKeywords.join(","),
    [customKeywords, draftKeywords],
  );

  function addKeyword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keyword = normalizeKeyword(newKeyword);
    if (!keyword) return;
    setDraftKeywords((current) =>
      current.includes(keyword) ? current : [...current, keyword],
    );
    setNewKeyword("");
    setSaveMessage(null);
  }

  function deleteKeyword(keyword: string) {
    setDraftKeywords((current) => current.filter((item) => item !== keyword));
    setSaveMessage(null);
  }

  function saveKeywords() {
    onSaveCustomKeywords(draftKeywords);
    setSaveMessage("Saved custom exclusion keywords.");
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`bullpen-scan-filter-${detailId}-title`}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {detail.dialogEyebrow}
            </p>
            <h2
              id={`bullpen-scan-filter-${detailId}-title`}
              className="text-xl font-semibold text-slate-950"
            >
              {detail.title}
            </h2>
            <p className="text-sm leading-6 text-slate-600">
              {detail.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close scan filter details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-950">
            {detail.matcherScope}
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-950">
              {algorithmTitle}
            </h3>
            <ol className="space-y-3 pl-5 text-sm leading-6 text-slate-700">
              {detail.algorithmSteps.map((step) => (
                <li key={step} className="list-decimal">
                  {step}
                </li>
              ))}
            </ol>
          </section>

          {supportsCustomKeywords ? (
            <section className="space-y-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-950">
                  Custom exclusion keywords
                </h3>
                <p className="text-xs leading-5 text-slate-600">
                  Add extra whole-word keywords for this exclusion. Click Save to persist them and include them in the next scan.
                </p>
              </div>
              <form onSubmit={addKeyword} className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(event) => setNewKeyword(event.target.value)}
                  placeholder="Add keyword or phrase"
                  className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-indigo-300"
                />
                <Button type="submit" variant="outline" className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </form>
              <div className="flex flex-wrap gap-2">
                {draftKeywords.length ? (
                  draftKeywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-700"
                    >
                      {keyword}
                      <button
                        type="button"
                        onClick={() => deleteKeyword(keyword)}
                        className="rounded-full text-slate-400 transition hover:text-red-600"
                        aria-label={`Delete custom keyword ${keyword}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))
                ) : (
                  <p className="text-xs text-slate-500">No custom keywords saved.</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={saveKeywords} disabled={!hasUnsavedChanges}>
                  Save keywords
                </Button>
                {saveMessage ? (
                  <p className="text-xs font-medium text-emerald-700">{saveMessage}</p>
                ) : null}
              </div>
            </section>
          ) : null}

          <DetailList
            title="Whole-word keyword sets"
            items={detail.keywordGroups ?? []}
            monospace
          />
          <DetailList
            title="Pattern rules"
            items={detail.patternRules ?? []}
            monospace
          />
          <DetailList
            title="Excluded event examples"
            items={detail.excludedEventExamples ?? []}
          />
        </div>
      </div>
    </div>
  );
}
