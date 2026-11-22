"use client";

import Link from "next/link";
import { useRef } from "react";
import { Menu } from "lucide-react";
import { DropdownMenu } from "radix-ui";

export type TileAction = { label: string; onSelect: () => void } | { label: string; href: string };

export function WorkflowTileMenu({ title, actions }: { title: string; actions: TileAction[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef(false);
  const itemClass = "flex min-h-9 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-slate-800 outline-none data-[highlighted]:bg-indigo-50 data-[highlighted]:text-indigo-800";
  return <DropdownMenu.Root modal={false} onOpenChange={open => { if (open) selected.current = false; }}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" aria-label={`${title} actions`} className="-my-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-700 hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-indigo-600">
        <Menu aria-hidden="true" className="size-5" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8}
      aria-label={`${title} actions`} className="z-50 grid max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-40 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg"
      onCloseAutoFocus={event => { if (selected.current) event.preventDefault(); }}>
      {actions.map(action => "href" in action ? <DropdownMenu.Item key={action.label} asChild>
        <Link href={action.href} className={itemClass}>{action.label}</Link>
      </DropdownMenu.Item> : <DropdownMenu.Item key={action.label} className={itemClass} onSelect={() => {
        selected.current = true;
        trigger.current?.focus();
        action.onSelect();
      }}>{action.label}</DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
