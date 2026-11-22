"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildSwingTradePrompt, validateZerodhaSwingSettings, type ZerodhaSwingSettings } from "../../../../lib/swingTrade";

export function PromptTemplateDialog({ title, body, onClose, onReviewInputs, swingSettings, onSaveSwingSettings }: {
  title: string;
  body: string;
  onClose: () => void;
  onReviewInputs: () => void;
  swingSettings?: ZerodhaSwingSettings;
  onSaveSwingSettings?: (settings: ZerodhaSwingSettings) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const [draft, setDraft] = useState(swingSettings);
  const [saveStatus, setSaveStatus] = useState("");
  const validated = draft && validateZerodhaSwingSettings(draft);
  const preview = validated?.settings
    ? buildSwingTradePrompt("india", validated.settings.investmentAmount, validated.settings)
    : body;
  const dirty = draft && swingSettings && (Object.keys(draft) as (keyof ZerodhaSwingSettings)[])
    .some(key => draft[key] !== swingSettings[key]);

  function save() {
    if (!validated?.settings || !onSaveSwingSettings) return;
    try {
      onSaveSwingSettings(validated.settings);
      setDraft(validated.settings);
      setSaveStatus("Saved for your next Zerodha Swing Scan in this browser.");
    } catch {
      setSaveStatus("Could not save these settings. Check your browser storage and signed-in account, then try again.");
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]'));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
      className="m-auto max-h-[85dvh] w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-violet-200 bg-violet-50 p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 xl:max-w-[95vw]"
    >
      <div className="flex max-h-[85dvh] flex-col overflow-y-auto">
        <div className="flex shrink-0 items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-violet-700">{draft ? "Scan settings" : "Template only"}</p>
            <h3 id={titleId} className="text-lg font-semibold text-slate-950">{title}</h3>
            <p id={descriptionId} className="mt-1 text-sm text-slate-600">
              {draft ? "Set the number of stocks, total investment and time horizon for your next scan." : "Prompt template used by this Auto-Rebalance stage. Runtime input bundles are added when the workflow runs."}
            </p>
            {!draft && <p className="mt-2 text-sm text-slate-700">This stage analyzes the portfolio and scan results selected for the workflow. This read-only preview is not the eventual request: selected data is added only when the workflow runs.</p>}
            <button type="button" onClick={onReviewInputs} disabled={dirty} className="mt-2 disabled:opacity-50 rounded text-sm font-medium text-violet-800 underline focus-visible:outline-2 focus-visible:outline-blue-600">Review selected inputs</button>
          </div>
          <button type="button" onClick={onClose} aria-label="Close prompt view"
            className="shrink-0 rounded-full px-3 py-1 text-sm hover:bg-violet-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
            Close
          </button>
        </div>
        {draft && <form className="mx-5 mb-4 shrink-0" onSubmit={event => { event.preventDefault(); save(); }}>
          <div className="grid gap-3 sm:grid-cols-3">
            {([
              ["stockCount", "Stocks to search", "numeric"],
              ["investmentAmount", "Amount to invest (₹)", "decimal"],
              ["horizon", "Swing horizon", "text"],
            ] as const).map(([key, label, inputMode]) => (
              <label key={key} className="text-sm font-medium text-slate-800">
                {label}
                <input className="mt-1 block w-full rounded-lg border border-violet-200 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-violet-600"
                  inputMode={inputMode} required value={draft[key]} onChange={event => {
                    setDraft({ ...draft, [key]: event.target.value });
                    setSaveStatus("");
                  }} />
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={!validated?.settings || !dirty} className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Save settings</button>
            <span role="status" className="text-sm text-slate-700">{validated?.error || saveStatus || (dirty ? "Save settings to use these values." : "")}</span>
          </div>
        </form>}
        <div className="mx-5 mb-5 min-h-0 overflow-y-auto overscroll-contain rounded-xl bg-slate-950 p-5 text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" tabIndex={0} aria-label="Prompt template text">
          <details open={draft ? true : undefined}>
            <summary tabIndex={0} className="cursor-pointer text-sm font-medium">{draft ? "Prompt preview" : "Advanced: raw prompt template"}</summary>
            <pre className="max-w-[100ch] whitespace-pre-wrap break-words font-mono text-sm leading-6 [overflow-wrap:anywhere]">{validated?.error ? "Enter valid settings to preview the prompt." : preview}</pre>
          </details>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
