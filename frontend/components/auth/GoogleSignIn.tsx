"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAuthRedirectTarget } from "@/lib/authRedirect";

type GoogleIdentity = {
  initialize(options: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    auto_select: boolean;
  }): void;
  renderButton(element: HTMLElement, options: {
    type: "standard"; theme: "outline"; size: "large"; text: "signin_with"; width: number;
  }): void;
};

export function GoogleSignIn({ redirectTo }: { redirectTo: string }) {
  const button = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading Google sign-in…");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    fetch("/backend-api/auth/google/config", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Unavailable");
        const config = await response.json();
        if (!active) return;
        if (config.enabled && typeof config.client_id === "string") {
          setClientId(config.client_id);
          setMessage("");
        } else {
          setMessage("Google sign-in is not configured yet. Use email and password below.");
        }
      })
      .catch(() => {
        if (active) setMessage("Google sign-in is unavailable. Use email and password below.");
      })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, []);

  useEffect(() => {
    if (!clientId) return;
    const ready = () => setScriptReady(true);
    const failed = () => setMessage("Google sign-in could not load. Use email and password below.");
    if ((window as Window & { google?: unknown }).google) {
      ready();
      return;
    }
    const existing = document.getElementById("google-identity-script") as HTMLScriptElement | null;
    const script = existing || document.createElement("script");
    script.addEventListener("load", ready);
    script.addEventListener("error", failed);
    if (!existing) {
      script.id = "google-identity-script";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      document.head.appendChild(script);
    }
    return () => {
      script.removeEventListener("load", ready);
      script.removeEventListener("error", failed);
    };
  }, [clientId]);

  const completeSignIn = useCallback(async ({ credential }: { credential: string }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const { signIn } = await import("next-auth/react");
      const result = await signIn("google", { credential, redirect: false });
      if (result?.error || !result?.ok) {
        setMessage("Google sign-in failed. Please try again or contact support if your account is disabled.");
        return;
      }
      window.location.assign(resolveAuthRedirectTarget(redirectTo));
    } catch {
      setMessage("Google sign-in could not be completed. Please try again or use your password.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [redirectTo]);

  useEffect(() => {
    if (!clientId || !scriptReady || !button.current) return;
    const google = (window as Window & { google?: { accounts: { id: GoogleIdentity } } }).google;
    if (!google) return;
    google.accounts.id.initialize({ client_id: clientId, callback: completeSignIn, auto_select: false });
    google.accounts.id.renderButton(button.current, {
      type: "standard", theme: "outline", size: "large", text: "signin_with",
      width: Math.min(400, button.current.clientWidth || 300),
    });
  }, [clientId, scriptReady, completeSignIn]);

  return (
    <div className="mb-5 space-y-3">
      <div ref={button} className={busy ? "pointer-events-none opacity-50" : "w-full flex justify-center"} aria-busy={busy} />
      <p className="text-center text-xs text-muted-foreground">New here? Google sign-in creates your own Cred-X profile.</p>
      {(busy || message) && <p role="status" className="text-sm text-muted-foreground">{busy ? "Signing in…" : message}</p>}
      <div className="text-center text-xs uppercase text-muted-foreground">or sign in with email</div>
    </div>
  );
}
