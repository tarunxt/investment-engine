"use client";
import { useId, useState, type ReactNode } from "react";

/** Hide the view, never unmount stateful details or change their requests/data. */
export function CollapsedSection({ title, children, className, headingClassName = "font-semibold" }: {
  title: string; children: ReactNode; className?: string; headingClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <section className={className}>
    <div className="flex items-center gap-3">
      <h3 className={headingClassName}>{title}</h3>
      <button type="button" aria-expanded={expanded} aria-controls={detailsId}
        aria-label={`${expanded ? "Hide" : "Expand"} ${title}`}
        onClick={() => setExpanded(current => !current)}
        className="inline-flex items-center gap-1 rounded-full border border-blue-200 px-3 py-1 text-sm font-semibold text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <span aria-hidden="true">{expanded ? "↑" : "↓"}</span>{expanded ? "Hide" : "Expand"}
      </button>
    </div>
    <div id={detailsId} hidden={!expanded}>{children}</div>
  </section>;
}
