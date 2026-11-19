"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/useAuth";
import { beginKiteSettingsLogin } from "@/lib/kiteSettingsLogin";
import { apiService } from "@/services/api";
import type { KiteBrokerConnection } from "@/types/api";

function formatDate(value: string | null) {
  if (!value) return "Unavailable";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value)) + " IST";
}

function BrokerSettings() {
  const [broker, setBroker] = useState<KiteBrokerConnection | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<"switch" | "remove" | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let current = true;
    apiService.zerodhaConnection().then(value => {
      if (current) setBroker(value);
    }).catch((e: Error) => {
      if (current) setError(e.message || "Could not load your broker connection.");
    });
    return () => { current = false; };
  }, [reload]);

  function refresh() {
    setError("");
    setBroker(null);
    setAction(null);
    setReload(value => value + 1);
  }

  async function signIn(clientId?: string) {
    if (!broker) return;
    setBusy(true);
    setError("");
    try {
      const login = await apiService.zerodhaLoginUrl();
      if (!login.configured) throw new Error("Kite Connect is not configured for this CredX account.");
      beginKiteSettingsLogin(login.login_url, { expected_revision: broker.revision, target_client_id: clientId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Kite sign-in.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!broker) return;
    setBusy(true);
    setError("");
    try {
      await apiService.zerodhaDisconnect(broker.revision);
      setNotice("Zerodha was removed from your CredX account.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the broker.");
    } finally {
      setBusy(false);
    }
  }

  const profile = broker?.profile;
  const fields = broker ? [
    ["Client ID", profile?.client_id],
    ["Account holder", profile?.name],
    ["PAN", profile?.masked_pan || "Unavailable from Kite"],
    ["Broker email", profile?.email],
    [broker.first_added_at ? "First added to CredX" : "Connection record created", formatDate(broker.first_added_at ?? broker.connection_record_created_at)],
    ["Last broker sign-in", formatDate(broker.login_time)],
    ["Session expires", formatDate(broker.expires_at)],
    ["Enabled exchanges", profile?.exchanges.join(", ")],
    ["Enabled products", profile?.products.join(", ")],
  ] : [];

  return (
    <section className="max-w-3xl space-y-5">
      <h3 className="text-lg font-medium">Connected Brokers</h3>
      <Separator />
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        {error}<Button variant="outline" size="sm" onClick={refresh} disabled={busy}>Refresh</Button>
      </div>}
      {!broker && !error && <p role="status" className="text-sm text-muted-foreground">Loading broker details…</p>}
      {broker && !broker.linked && <div className="space-y-4">
        <p>No broker connected.</p>
        <Button disabled={busy} onClick={() => void signIn()}>Connect Zerodha</Button>
      </div>}
      {broker?.linked && <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">Zerodha · Kite</h4>
          <span className={broker.session_active ? "text-sm text-emerald-700" : "text-sm text-amber-700"}>
            {broker.session_active ? "Session active" : "Sign-in required"}
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {fields.map(([label, value]) => <div key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words font-medium">{value || "Unavailable"}</dd>
          </div>)}
        </dl>
        <Separator />
        {!action && <div className="flex flex-wrap gap-2">
          {!broker.session_active && <Button disabled={busy} onClick={() => void signIn(profile?.client_id)}>Renew sign-in</Button>}
          <Button variant="outline" disabled={busy} onClick={() => { setTarget(""); setAction("switch"); }}>Switch broker</Button>
          <Button variant="destructive" disabled={busy} onClick={() => setAction("remove")}>Remove broker</Button>
        </div>}
        {action === "remove" && <div className="space-y-3 rounded-md border p-4">
          <p className="font-medium">Remove Zerodha{profile?.client_id ? ` (${profile.client_id})` : ""}?</p>
          <p className="text-sm text-muted-foreground">CredX will disconnect this account. Your saved portfolio history will remain available.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>Confirm removal</Button>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>Cancel</Button>
          </div>
        </div>}
        {action === "switch" && <form className="space-y-3 rounded-md border p-4" onSubmit={event => { event.preventDefault(); void signIn(target); }}>
          <p className="font-medium">Switch Zerodha account</p>
          <p className="text-sm text-muted-foreground">Enter the replacement client ID, then sign in to that account on Kite. CredX replaces the current link after Kite verifies the ID.</p>
          {broker.assigned_client_id && <p className="text-sm">Your personal Kite app is assigned to {broker.assigned_client_id}. A different client ID requires its own Kite app assignment.</p>}
          <Label htmlFor="kite-client">Replacement client ID</Label>
          <Input id="kite-client" className="max-w-xs" autoComplete="off" required pattern="[A-Z0-9]{1,32}" maxLength={32}
            value={target} onChange={e => setTarget(e.target.value.trim().toUpperCase())} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !target || target === profile?.client_id || (!!broker.assigned_client_id && target !== broker.assigned_client_id)}>Continue to Kite</Button>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>Cancel</Button>
          </div>
        </form>}
      </>}
    </section>
  );
}

export default function ConnectedBrokersPage() {
  const { user } = useAuth();
  return user ? <BrokerSettings key={user.id} /> : null;
}
