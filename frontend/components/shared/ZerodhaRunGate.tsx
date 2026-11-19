"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ZerodhaStatusResponse } from "@/types/api";

type State = "checking" | "unknown" | "disconnected" | "connecting" | "success" | "ready";

export function ZerodhaRunGate({ getStatus, connect, disabled, children }: {
  getStatus: () => Promise<ZerodhaStatusResponse>;
  connect: () => Promise<void>;
  disabled: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const connecting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (connecting.current) return;
    const request = ++version.current;
    clearTimeout(timer.current);
    try {
      const status = await getStatus();
      if (request !== version.current) return;
      setState(status.connected ? "ready" : "disconnected");
      setMessage("");
      const expires = status.expires_at && Date.parse(status.expires_at);
      if (status.connected && expires && expires > Date.now()) {
        timer.current = setTimeout(() => { setState("checking"); void refresh(); }, expires - Date.now());
      }
    } catch {
      if (request !== version.current) return;
      setState("unknown");
      setMessage("CredX could not check your Zerodha connection.");
    }
  }, [getStatus]);

  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      version.current++;
      window.removeEventListener("focus", refresh);
      clearTimeout(timer.current);
    };
  }, [refresh]);

  async function startConnection() {
    if (disabled || connecting.current) return;
    connecting.current = true;
    const request = ++version.current;
    clearTimeout(timer.current);
    setState("connecting");
    setMessage("");
    try {
      await connect();
      if (request !== version.current) return;
      setState("success");
      timer.current = setTimeout(() => {
        connecting.current = false;
        void refresh();
      }, 1600);
    } catch (error) {
      if (request !== version.current) return;
      connecting.current = false;
      setState("disconnected");
      setMessage(error instanceof Error ? error.message : "Zerodha sign-in could not be completed.");
    }
  }

  if (state === "ready") return <>{children}</>;
  if (state === "success") return <div role="status" className="flex items-center gap-2 rounded-full bg-emerald-100 px-4 py-2 font-semibold text-emerald-900 motion-safe:animate-in motion-safe:zoom-in-95">
    <CheckCircle2 className="size-5 motion-safe:animate-bounce" /> Congratulations, you’re connected!
  </div>;
  const busy = state === "checking" || state === "connecting";
  return <div className="flex flex-col items-end gap-2">
    <Button type="button" disabled={busy || disabled}
      onClick={state === "unknown" ? () => { setState("checking"); void refresh(); } : startConnection}
      className="min-h-11 rounded-full bg-emerald-700 px-5 font-semibold text-white hover:bg-emerald-800">
      {busy ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <Link2 className="size-4" />}
      {state === "checking" ? "Checking broker…" : state === "connecting" ? "Connecting…" : state === "unknown" ? "Retry connection check" : "Connect Broker"}
    </Button>
    {message && <p role="alert" className="max-w-xs text-sm text-red-800">{message}</p>}
  </div>;
}
