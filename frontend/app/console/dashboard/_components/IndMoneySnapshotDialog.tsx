"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatApiTimestamp } from "@/lib/datetime";
import { readIndmoneySnapshotSource, sameIndmoneySnapshotSource, type ReadIndmoneySnapshot } from "@/lib/indmoneySnapshotSource";
import type { IndMoneyUsPortfolioSnapshotCreateRequest, IndMoneyUsPortfolioSnapshotDetail } from "@/types/api";

type IndMoneySyncMode = "paste" | "reuse";
const formatTimestamp = (value: string) => formatApiTimestamp(value, { emptyValue: "Not available", locale: "en-IN", timeZone: "Asia/Kolkata", timeZoneName: "short" });

type SnapshotDialogProps = {
  open: boolean;
  saving: boolean;
  error: string | null;
  loadSnapshot: ReadIndmoneySnapshot;
  onClose: () => void;
  onContinue: (
    mode: IndMoneySyncMode,
    payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
    savedSnapshot?: IndMoneyUsPortfolioSnapshotDetail,
  ) => void;
};

export function IndMoneySnapshotDialog(props: SnapshotDialogProps) {
  return props.open ? <SnapshotDialogContent {...props} /> : null;
}

function SnapshotDialogContent({
  open,
  saving,
  error,
  loadSnapshot,
  onClose,
  onContinue,
}: SnapshotDialogProps) {
  const [mode, setMode] = useState<IndMoneySyncMode>("paste");
  const [rawText, setRawText] = useState("");
  const pasteInputRef = useRef<HTMLTextAreaElement | null>(null);

  const [source, setSource] = useState<IndMoneyUsPortfolioSnapshotDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const lifecycle = useRef({ active: true });

  useEffect(() => {
    if (!open) return;
    const current = { active: true };
    lifecycle.current = current;
    void readIndmoneySnapshotSource(loadSnapshot).then((snapshot) => {
      if (current.active) setSource(snapshot);
    }).catch((cause: unknown) => {
      if (current.active) setSourceError(cause instanceof Error ? cause.message : "Unable to load saved snapshot.");
    }).finally(() => {
      if (current.active) setSourceLoading(false);
    });
    return () => { current.active = false; };
  }, [open, loadSnapshot]);

  const handleContinue = useCallback(async () => {
    if (saving || verifying) return;
    if (mode === "paste") {
      if (rawText.trim()) onContinue(mode, { raw_text: rawText.trim(), captured_at: new Date().toISOString() });
      return;
    }
    if (!source || sourceLoading) return;
    const current = lifecycle.current;
    setVerifying(true);
    setSourceError(null);
    try {
      const latest = await readIndmoneySnapshotSource(loadSnapshot);
      if (!current.active) return;
      if (!sameIndmoneySnapshotSource(source, latest)) {
        setSource(latest);
        setSourceError("The saved snapshot changed. Review the updated source and continue again to use it.");
        return;
      }
      onContinue("reuse", undefined, latest);
    } catch (cause: unknown) {
      if (!current.active) return;
      setSource(null);
      setSourceError(cause instanceof Error ? cause.message : "Unable to verify saved snapshot.");
    } finally {
      if (current.active) setVerifying(false);
    }
  }, [mode, onContinue, rawText, source, sourceLoading, loadSnapshot, saving, verifying]);

  useEffect(() => {
    if (!open) return;

    window.requestAnimationFrame(() => {
      const pasteInput = pasteInputRef.current;
      pasteInput?.focus();
      pasteInput?.select();
    });
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">
              Sync INDmoney US Portfolio
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Continue with the last saved snapshot or paste the latest INDmoney
              screen before the rebalance workflow runs.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label
            className={cn(
              "rounded-2xl border p-4 text-sm font-semibold",
              mode === "paste"
                ? "border-blue-200 bg-blue-50 text-blue-900"
                : "border-slate-200 text-slate-800",
            )}
          >
            <input
              className="mr-2"
              type="radio"
              disabled={verifying || saving}
              checked={mode === "paste"}
              onChange={() => setMode("paste")}
            />
            Paste latest INDmoney snapshot
          </label>
          <label
            className={cn(
              "rounded-2xl border p-4 text-sm font-semibold",
              mode === "reuse"
                ? "border-blue-200 bg-blue-50 text-blue-900"
                : "border-slate-200 text-slate-800",
            )}
          >
            <span className="flex items-start gap-2">
              <input
                className="mt-0.5"
                type="radio"
                disabled={verifying || saving || sourceLoading || !source}
                checked={mode === "reuse"}
                onChange={() => setMode("reuse")}
              />
              <span>
                Continue with latest snapshot
                <span className="mt-1 block text-xs font-medium text-slate-500">
                  {sourceLoading ? "Loading saved snapshot…" : source
                    ? `Snapshot #${source.id} · Captured: ${formatTimestamp(source.captured_at)}`
                    : "Saved snapshot unavailable"}
                  <span className="mt-1 block">The saved source is checked again when you continue. If it changes, review the updated snapshot before proceeding.</span>
                </span>
              </span>
            </span>
          </label>
        </div>

        {mode === "paste" ? (
          <textarea
            ref={pasteInputRef}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || !rawText.trim() || saving) {
                return;
              }

              event.preventDefault();
              handleContinue();
            }}
            placeholder="Paste the copied INDmoney portfolio screen here..."
            className="mt-4 min-h-64 w-full resize-y rounded-2xl border border-blue-200 bg-white p-3 text-sm outline-none focus:border-blue-400"
          />
        ) : null}

        {sourceError ? <p role="alert" className="mt-3 text-sm text-amber-800">{sourceError}</p> : null}

        {error ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || verifying || (mode === "paste" ? !rawText.trim() : sourceLoading || !source)}
            onClick={() => { void handleContinue(); }}
            className="rounded-full bg-slate-950 px-7 font-extrabold uppercase tracking-[0.18em] text-white hover:bg-slate-800"
          >
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Continue Rebalance
          </Button>
        </div>
      </div>
    </div>
  );
}

