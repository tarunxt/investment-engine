"use client";

import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";

export function DashboardTileInfoDialog({ info, onClose, onReturnFocus }: {
  info: { title: string; body: string };
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/50" />
      <Dialog.Content
        onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}
        className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 text-slate-950 shadow-xl"
      >
        <Dialog.Title className="text-lg font-semibold">{info.title}</Dialog.Title>
        <Dialog.Description className="mt-3 text-sm leading-6 text-slate-600">{info.body}</Dialog.Description>
        <Dialog.Close asChild><Button type="button" variant="outline" className="mt-5">Close</Button></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
