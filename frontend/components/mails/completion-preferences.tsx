'use client';

import { useState } from 'react';
import { Dialog } from 'radix-ui';
import { ChevronRight, Settings2, X } from 'lucide-react';

export type CompletionPreference = {
  key: string;
  label: string;
  enabled: boolean;
  segments: string[];
};

export function CompletionPreferences({ items, disabled, onApply }: {
  items: CompletionPreference[];
  disabled: boolean;
  onApply: (values: Record<string, boolean>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const count = items.filter((item) => item.enabled).length;
  function changeOpen(value: boolean) {
    if (value) setDraft(Object.fromEntries(items.map((item) => [item.key, item.enabled])));
    setOpen(value);
  }
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <button type="button" disabled={disabled} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition hover:bg-muted/40 disabled:opacity-50">
          <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
          <span className="flex-1">
            <span className="block text-sm font-semibold">Stage and scan completion</span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              {['Zerodha', 'IndMoney', 'Bullpen'].map((name) => <span key={name} className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-700">{name}</span>)}
            </span>
            <span className="mt-2 block text-xs text-muted-foreground">{count} of {items.length} notifications selected · Configure stages</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl">
          <Dialog.Title className="pr-8 text-xl font-bold">Stage and scan completion</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">Choose which completion emails you receive for each platform. Apply your selection, then save preferences.</Dialog.Description>
          <Dialog.Close aria-label="Close stage preferences" className="absolute right-4 top-4 rounded-lg p-2 hover:bg-muted"><X className="h-4 w-4" /></Dialog.Close>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {['Zerodha', 'IndMoney', 'Bullpen'].map((segment) => {
              const options = items.filter((item) => item.segments.includes(segment));
              return <fieldset key={segment} className="rounded-xl border border-border p-4">
                <legend className="px-1 font-bold">{segment}</legend>
                <div className="mb-3 flex gap-3 text-xs font-semibold text-violet-700">
                  {[true, false].map((value) => <button key={String(value)} type="button" onClick={() => setDraft((current) => ({ ...current, ...Object.fromEntries(options.map((item) => [item.key, value])) }))}>{value ? 'Select all' : 'Deselect all'}</button>)}
                </div>
                <div className="space-y-3">
                  {options.map((item) => <label key={item.key} className={`flex cursor-pointer items-start gap-2 text-sm ${item.key.endsWith('.overall') ? 'border-t border-border pt-3 font-semibold' : ''}`}>
                    <input type="checkbox" aria-label={`${segment} ${item.label}`} checked={draft[item.key] ?? false} onChange={(event) => setDraft((current) => ({ ...current, [item.key]: event.target.checked }))} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-600" />
                    <span>{item.label}</span>
                  </label>)}
                </div>
                {segment === 'Bullpen' ? <p className="mt-4 rounded-lg bg-violet-50 p-3 text-xs leading-5 text-violet-900">Stage 1 completion emails trigger the cluster update job. Turn this off to stop those triggers.</p> : null}
              </fieldset>;
            })}
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close className="rounded-xl border border-border px-4 py-2 text-sm font-semibold">Cancel</Dialog.Close>
            <button type="button" onClick={() => { onApply(draft); setOpen(false); }} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">Apply selection</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
