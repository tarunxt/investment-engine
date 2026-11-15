"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Menu, X, ArrowLeft } from "lucide-react";
import styles from "./BasketMetricPopup.module.css";
export type BasketMetricSummary = {
  label: string; value: string; subtitle: string;
  metrics: { label: string; value: string }[];
  notice: string; warning?: boolean; status?: "loading" | "error";
};
function ModalLayer({ title, eyebrow, onClose, children, footer, tools, covered = false, details = false, wide = false }: {
  title: string; eyebrow: string; onClose: () => void; children: ReactNode;
  footer: ReactNode; tools?: ReactNode; covered?: boolean; details?: boolean; wide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (!covered && panel.current && !panel.current.contains(document.activeElement)) {
      (panel.current.querySelector<HTMLElement>('[aria-haspopup="dialog"]') ?? panel.current).focus();
    }
  }, [covered]);
  return createPortal(
    <div className={`${styles.overlay} ${details ? styles.secondary : ""}`} inert={covered || undefined} aria-hidden={covered || undefined}
      onClick={event => { event.stopPropagation(); if (!covered) onClose(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (covered) return;
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
      }}>
      <section role="dialog" aria-modal={covered ? undefined : true} aria-label={title} tabIndex={-1} ref={panel}
        className={`${styles.panel} ${wide ? styles.widePanel : ""} ${details ? styles.detailPanel : ""}`} onClick={event => event.stopPropagation()}>
        <header className={styles.header}>
          <div><p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2></div>
          <div className={styles.actions}>{tools}<button type="button" className={styles.iconButton} aria-label={details ? "Close calculation details" : "Close metric summary"} onClick={onClose}><X size={19} aria-hidden="true" /></button></div>
        </header>
        <div className={styles.body}>{children}</div>
        <footer className={styles.footer}><span>Display only · Orders unchanged</span>{footer}</footer>
      </section>
    </div>, document.body,
  );
}
/** Presentation only: values and audit detail come from the existing calculation. */
export function BasketMetricPopup({ title, eyebrow, summary, children, onClose, wide = false }: {
  title: string; eyebrow: string; summary: BasketMetricSummary; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return <>
    <ModalLayer title={title} eyebrow={eyebrow} onClose={onClose} covered={detailsOpen} wide={wide}
      tools={<button type="button" className={`${styles.iconButton} ${styles.menuButton}`} aria-label="Calculation details" title="Calculation details" aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}><Menu size={21} aria-hidden="true" /></button>}
      footer={<button type="button" className={styles.button} onClick={onClose}>Done</button>}>
      <div className={styles.hero} aria-live="polite">
        <p className={styles.label}>{summary.label}</p><p className={styles.value}>{summary.value}</p><p className={styles.subtitle}>{summary.subtitle}</p>
      </div>
      <dl className={styles.metrics}>{summary.metrics.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
      <p className={`${styles.notice} ${summary.warning ? styles.warning : ""}`} role={summary.status === "error" ? "alert" : summary.status === "loading" ? "status" : undefined}>{summary.notice}</p>
    </ModalLayer>
    {detailsOpen && <ModalLayer title="Behind the number" eyebrow={`${eyebrow} / ${title}`} details onClose={() => setDetailsOpen(false)}
      footer={<button type="button" className={styles.button} onClick={() => setDetailsOpen(false)}><ArrowLeft size={16} aria-hidden="true" />Back to summary</button>}>
      <div className={styles.detailHeading}>Calculation & source history</div>
      <div className={styles.details}>{children}</div>
    </ModalLayer>}
  </>;
}

export { ModalLayer as BasketModalLayer };
