"use client";
import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { captureWorkflowOwner, onWorkflowOwnerInvalidated } from "@/lib/workflowOwnerLifetime";
import { useAuth } from "@/hooks/useAuth";
import { ScorecardReview } from "@/app/console/dashboard/_components/ScorecardReview";
import { migratedPolicy, type CardKey } from "@/lib/independentScorecards";
import { loadScoreMatrixFormulaConfig } from "./FinalActionablesConsole";

export function ScorecardStandalone({portfolio,stage}:{portfolio:"zerodha"|"indmoneyUs";stage:CardKey|"actionables"|"source"}){
  const {user}=useAuth();
  const router=useRouter();
  const [policy,setPolicy]=useState(()=>migratedPolicy(loadScoreMatrixFormulaConfig()));
  const [revision,setRevision]=useState<number>();
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  if(!user||owner?.id!==user.id)return null;
  return <ScorecardReview key={owner.generation} portfolio={portfolio} stage={stage} fallbackPolicy={policy} revisionId={revision}
    onRevision={setRevision} onPolicy={setPolicy} onClose={()=>router.push(portfolio==="zerodha"?"/console/zerodha#india-workflow":"/console/indmoney-us")}/>;
}

