"use client";

import { useState } from "react";
import { RotateCcw, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BULLPEN_LLM_PROMPT_PLACEHOLDER,
  DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
} from "@/lib/bullpen-ai";

type BullpenPromptEditorDialogProps = {
  value: string;
  onClose: () => void;
  onSave: (value: string) => Promise<void> | void;
};

export function BullpenPromptEditorDialog({
  value,
  onClose,
  onSave,
}: BullpenPromptEditorDialogProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const hasPlaceholder = draft.includes(BULLPEN_LLM_PROMPT_PLACEHOLDER);
  const isDirty = draft !== value;

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Prompt cannot be empty.");
      return;
    }

    setIsSaving(true);
    try {
      await onSave(trimmed);
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save the prompt right now.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Bullpen LLM Prompt
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              Inspect and edit the prompt
            </h2>
            <p className="text-sm leading-6 text-slate-600">
              Selected questions will be injected where{" "}
              <code>{BULLPEN_LLM_PROMPT_PLACEHOLDER}</code> appears.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close prompt editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-3">
            <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            disabled={isSaving}
            spellCheck={false}
            className="min-h-[420px] w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 font-mono text-sm leading-6 text-slate-900 outline-none transition focus:border-slate-400"
            />

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
              <p>
                {hasPlaceholder
                  ? "The selected-questions placeholder is present."
                  : "The placeholder was removed. Selected questions will be appended automatically when the run starts."}
              </p>
              <p>{draft.length.toLocaleString("en-IN")} characters</p>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE);
                setError(null);
              }}
              disabled={isSaving}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset default
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(value);
                setError(null);
              }}
              disabled={!isDirty || isSaving}
            >
              Revert changes
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? "Saving..." : "Save prompt"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
