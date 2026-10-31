"use client";
import { useState, Children, Fragment, cloneElement, isValidElement, type MouseEvent, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { orderedBasketColumns, moveBasketColumn } from "@/lib/basketColumnPreferences";
import { BasketModalLayer } from "./BasketMetricPopup";

type Element = ReactElement<{ children?: ReactNode; colSpan?: number; [key: string]: unknown }>;
function flatten(nodes: ReactNode): ReactNode[] {
  return Children.toArray(nodes).flatMap(node => isValidElement(node) && node.type === Fragment ? flatten((node as Element).props.children) : [node]);
}
function text(nodes: ReactNode): string {
  return flatten(nodes).map(node => isValidElement(node) ? text((node as Element).props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "").join("").trim();
}
export function basketTableColumns(table: ReactNode): string[] {
  if (!isValidElement(table)) return [];
  const element = table as Element;
  if (element.type === "tr") return flatten(element.props.children).filter(node => isValidElement(node) && node.type === "th").map(node => typeof (node as Element).props["data-column-label"] === "string" ? String((node as Element).props["data-column-label"]) : text((node as Element).props.children));
  for (const child of flatten(element.props.children)) {
    const labels = basketTableColumns(child);
    if (labels.length) return labels;
  }
  return [];
}

/** Preserve every cell/control and handler; visibility never rewrites order data. */
export function BasketColumnTable({ children, hidden, onOpen, order = [], names = {}, onRequestRename }: { children: ReactElement; hidden: string[]; onOpen: (labels: string[]) => void; order?: string[]; names?: Record<string, string>; onRequestRename?: (id: string) => void }) {
  const labels = basketTableColumns(children);
  const count = labels.filter(label => !hidden.includes(label)).length + 1;
  function visit(node: ReactNode): ReactNode {
    if (!isValidElement(node)) return node;
    const element = node as Element;
    if (element.type === "tr") {
      const cells = flatten(element.props.children);
      if (cells.length === 1 && isValidElement(cells[0]) && (cells[0] as Element).props.colSpan) {
        return cloneElement(element, {}, cloneElement(cells[0] as Element, { colSpan: count }));
      }
      const header = cells.some(cell => isValidElement(cell) && cell.type === "th");
      const columns = orderedBasketColumns(labels, order).map(id => {
        const cell = cells[labels.indexOf(id)];
        if (!isValidElement(cell)) return cell;
        const props: Record<string, unknown> = { key: `column:${id}`, hidden: hidden.includes(id), "data-basket-column": id };
        if (header) {
          if (names[id]) props.children = id === "Selection" ? <>{(cell as Element).props.children}<span>{names[id]}</span></> : names[id];
          if (onRequestRename) { props.tabIndex = 0; props.onContextMenu = (event: MouseEvent) => { event.preventDefault(); onRequestRename(id); }; props.onKeyDown = (event: KeyboardEvent) => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); onRequestRename(id); } }; }
        }
        return cloneElement(cell as Element, props);
      });
      columns.push(header
        ? <th key="column-picker" className="sticky right-0 bg-slate-50 px-3 py-3" data-column-control><button type="button" aria-label="Choose basket columns" aria-haspopup="dialog" onClick={() => onOpen(labels)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-300"><Menu size={18} aria-hidden="true" /></button></th>
        : <td key="column-control" className="sticky right-0 bg-white px-3" aria-hidden="true" data-column-control />);
      return cloneElement(element, {}, columns);
    }
    return cloneElement(element, {}, Children.map(element.props.children, visit));
  }
  return visit(children);
}

export function BasketColumnPicker({ labels, hidden, onToggle, onClose, order = [], names = {}, onReorder, onRequestRename, covered = false }: { labels: string[]; hidden: string[]; onToggle: (label: string) => void; onClose: () => void; order?: string[]; names?: Record<string, string>; onReorder?: (order: string[]) => void; onRequestRename?: (id: string) => void; covered?: boolean }) {
  const ids = orderedBasketColumns(labels, order);
  return <BasketModalLayer title="Basket columns" eyebrow="Place Order Basket" covered={covered} onClose={onClose} footer={<button type="button" className="rounded-full bg-emerald-50 px-5 py-3 font-semibold text-emerald-800" onClick={onClose}>Done</button>}>
    <div className="space-y-2">{ids.map((id, index) => <div key={id} data-column-id={id} draggable={Boolean(onReorder)} tabIndex={0} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2"
      onDragStart={event => { event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()}
      onDrop={event => { event.preventDefault(); const moving = event.dataTransfer.getData('text/plain'); if (ids.includes(moving)) onReorder?.(moveBasketColumn(ids, moving, index)); }}
      onContextMenu={event => { if (onRequestRename) { event.preventDefault(); onRequestRename(id); } }}
      onKeyDown={event => { if (event.altKey && ['ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); onReorder?.(moveBasketColumn(ids, id, index + (event.key === 'ArrowUp' ? -1 : 1))); } else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); onRequestRename?.(id); } }}>
      <span aria-hidden="true" className="cursor-grab">⋮⋮</span><label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"><input type="checkbox" checked={!hidden.includes(id)} onChange={() => onToggle(id)} className="size-4" />{names[id] ?? id}</label>
      {onReorder ? <><button type="button" aria-label={`Move ${names[id] ?? id} up`} disabled={index === 0} onClick={() => onReorder(moveBasketColumn(ids, id, index - 1))}>↑</button><button type="button" aria-label={`Move ${names[id] ?? id} down`} disabled={index === ids.length - 1} onClick={() => onReorder(moveBasketColumn(ids, id, index + 1))}>↓</button></> : null}
    </div>)}</div>
  </BasketModalLayer>;
}

export function BasketColumnRename({ id, name, onSave, onClose }: { id: string; name: string; onSave: (name: string) => void; onClose: () => void }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name);
  const trimmed = draft.trim();
  return <BasketModalLayer title={editing ? 'Rename column' : 'Column options'} eyebrow={name} details onClose={onClose} footer={<button type="button" onClick={onClose}>Cancel</button>}>
    {editing ? <form onSubmit={event => { event.preventDefault(); if (trimmed && trimmed.length <= 64) { onSave(trimmed); onClose(); } }}><label className="block">Column name<input autoFocus aria-label="Column name" maxLength={64} value={draft} onChange={event => setDraft(event.target.value)} className="block w-full rounded border p-3" /></label>{!trimmed ? <p role="alert">Enter a non-empty column name.</p> : null}<button type="submit" disabled={!trimmed} className="mt-3 rounded-full bg-emerald-50 px-5 py-3">Save name</button><p className="mt-3 text-xs">Display name only. Calculation identity remains {id}.</p></form> : <div role="menu"><button role="menuitem" type="button" onClick={() => setEditing(true)}>Rename</button></div>}
  </BasketModalLayer>;
}
