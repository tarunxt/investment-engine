"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiService } from "@/services/api";
import { workflowOwnedApi } from "@/lib/workflowOwnedApi";
import { screenerApi, type Library } from "@/lib/screenerLibrary";
import type { WorkflowOwner } from "@/lib/workflowOwnerLifetime";

export function useScreenerLibrary(owner: WorkflowOwner) {
  const client = useMemo(() => workflowOwnedApi(apiService, owner), [owner]);
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    setError("");
    client.get<Library>(screenerApi()).then(value => {
      if (active) setLibrary(value);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [client, revision]);
  useEffect(() => {
    window.addEventListener("pageshow", reload);
    window.addEventListener("screener-library-changed", reload);
    return () => {
      window.removeEventListener("pageshow", reload);
      window.removeEventListener("screener-library-changed", reload);
    };
  }, [reload]);
  return { client, library, setLibrary, error, reload };
}
