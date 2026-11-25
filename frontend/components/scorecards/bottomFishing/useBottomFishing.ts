"use client";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {apiService} from "@/services/api";
import {workflowOwnedApi} from "@/lib/workflowOwnedApi";
import type {WorkflowOwner} from "@/lib/workflowOwnerLifetime";
import {apiPath, pending, type Manual, type Settings, type Snapshot} from "./model";

export function useBottomFishing(owner:WorkflowOwner) {
  const client = useMemo(() => workflowOwnedApi(apiService,owner),[owner]);
  const [data,setData] = useState<Snapshot|null>(null);
  const [error,setError] = useState("");
  const [sending,setSending] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const result = await client.get<Snapshot>(apiPath());
      if (ticket === sequence.current) { setData(result); setError(""); }
    } catch (e) { if (ticket === sequence.current) setError(String(e)); }
  },[client]);
  useEffect(() => { void refresh(); return () => { sequence.current++; }; },[refresh]);
  const active = pending(data?.manual?.status);
  useEffect(() => {
    const timer = setInterval(() => void refresh(),active ? 2500 : 30000);
    return () => clearInterval(timer);
  },[refresh,active]);
  async function run(version?:number) {
    setSending(true);
    try {
      const manual = await client.post<Manual>(apiPath()+"/run",version===undefined?{}:{version});
      sequence.current++;
      setData(previous => previous && {...previous,manual});
      await refresh();
      return true;
    } catch (e) {
      setError(String(e));
      if(version!==undefined) throw e;
      return false;
    } finally { setSending(false); }
  }
  async function save(settings:Settings, version:number) {
    const result = await client.post<Snapshot>(apiPath()+"/inputs",{...settings,version}).catch(async e=>{
      if(e?.status===409) await refresh();
      throw e;
    });
    sequence.current++;
    setData(result); setError("");
    return result.version;
  }
  return {client, data, error, refresh, active, sending, run, save};
}
export type Model = ReturnType<typeof useBottomFishing>;
