"use client";
import { Children, Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Menu } from "lucide-react";
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
export function BasketColumnTable({ children, hidden, onOpen }: { children: ReactElement; hidden: string[]; onOpen: (labels: string[]) => void }) {
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
      const columns = cells.map((cell, index) => isValidElement(cell) ? cloneElement(cell as Element, { key: `column:${labels[index] ?? index}`, hidden: hidden.includes(labels[index]), "data-basket-column": labels[index] }) : cell);
      columns.push(header
        ? <th key="column-picker" className="sticky right-0 bg-slate-50 px-3 py-3" data-column-control><button type="button" aria-label="Choose basket columns" aria-haspopup="dialog" onClick={() => onOpen(labels)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-300"><Menu size={18} aria-hidden="true" /></button></th>
        : <td key="column-control" className="sticky right-0 bg-white px-3" aria-hidden="true" data-column-control />);
      return cloneElement(element, {}, columns);
    }
    return cloneElement(element, {}, Children.map(element.props.children, visit));
  }
  return visit(children);
}

export function BasketColumnPicker({ labels, hidden, onToggle, onClose }: { labels: string[]; hidden: string[]; onToggle: (label: string) => void; onClose: () => void }) {
  return <BasketModalLayer title="Basket columns" eyebrow="Place Order Basket" onClose={onClose} footer={<button type="button" className="rounded-full bg-emerald-50 px-5 py-3 font-semibold text-emerald-800" onClick={onClose}>Done</button>}>
    <div className="space-y-2">{labels.map(label => <label key={label} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3"><input type="checkbox" checked={!hidden.includes(label)} onChange={() => onToggle(label)} className="size-4" />{label}</label>)}</div>
  </BasketModalLayer>;
}
