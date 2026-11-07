"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { useAuth } from "@/hooks/useAuth";

type PromptDrafts = Map<string, string>;
const PromptDraftContext = createContext<PromptDrafts | null>(null);

function PromptDraftScope({ children, active }: { children: ReactNode; active: boolean }) {
  const [drafts] = useState<PromptDrafts>(() => new Map());
  return <PromptDraftContext.Provider value={active ? drafts : null}>{children}</PromptDraftContext.Provider>;
}

/** Memory only: route changes retain edits; account/session changes discard them. */
export function SessionPromptDrafts({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { data: session, status } = useSession();
  const generation = session?.generation;
  const active = !loading && user?.is_active === true && status === "authenticated"
    && Number.isSafeInteger(user.id) && user.id > 0 && typeof generation === "string" && generation.length > 0
    && session?.user?.id === String(user.id);
  const owner = active ? `${user.id}:${generation}` : "unavailable";
  return <PromptDraftScope key={owner} active={active}>{children}</PromptDraftScope>;
}

export function useSessionPromptDrafts() {
  return useContext(PromptDraftContext);
}
