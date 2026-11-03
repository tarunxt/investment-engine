"use client";

import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useReviewDialog } from "@/hooks/useReviewDialog";

function DetailLoadNotice({ failed = false, retry, close }: { failed?: boolean; retry?: () => void; close?: () => void }) {
  const dialog = useReviewDialog<HTMLDivElement>(true, close ?? (() => {}));
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/55 p-4">
    <div {...dialog} role="dialog" aria-modal="true" aria-label={failed ? "Detail unavailable" : "Loading detail"} className="rounded-2xl bg-white p-6 text-slate-950 shadow-xl dark:bg-slate-900 dark:text-white">
      <p role="status">{failed ? "This detail could not load. Your live controls remain available." : "Loading detail…"}</p>
      <div className="mt-4 flex gap-3">{retry && <button type="button" onClick={retry}>Retry detail</button>}{close && <button type="button" onClick={close}>Close</button>}</div>
    </div>
  </div>;
}

class DetailLoadBoundary extends Component<{ children: ReactNode; retry: () => void; close?: () => void; active: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? (this.props.active ? <DetailLoadNotice failed retry={this.props.retry} close={this.props.close} /> : null) : this.props.children; }
}

/** A fresh lazy instance on retry permits a failed chunk request to be retried. */
export function deferBullpenDetail<P extends object>(load: () => Promise<ComponentType<P>>) {
  return function DeferredBullpenDetail(props: P) {
    const [attempt, setAttempt] = useState(0);
    const opener = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
    useEffect(() => () => { if (opener.current?.isConnected) opener.current.focus(); }, []);
    const [View, setView] = useState(() => lazy(async () => ({ default: await load() })));
    const close = (props as { onClose?: () => void }).onClose;
    const active = (props as { open?: boolean }).open !== false;
    const wasActive = useRef(active);
    useEffect(() => {
      if (wasActive.current && !active && opener.current?.isConnected) opener.current.focus();
      wasActive.current = active;
    }, [active]);
    return <DetailLoadBoundary active={active} key={attempt} retry={() => { setView(() => lazy(async () => ({ default: await load() }))); setAttempt(value => value + 1); }} close={close}>
      <Suspense fallback={active ? <DetailLoadNotice close={close} /> : null}><View {...props} /></Suspense>
    </DetailLoadBoundary>;
  };
}
