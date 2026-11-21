"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { ScorecardReview } from "@/app/console/dashboard/_components/ScorecardReview";
import { migratedPolicy, type CardKey } from "@/lib/independentScorecards";
import { loadScoreMatrixFormulaConfig } from "./FinalActionablesConsole";

export function ScorecardStandalone({portfolio,stage}:{portfolio:"zerodha"|"indmoneyUs";stage:CardKey|"actionables"|"source"}){
  const {user}=useAuth();
  const router=useRouter();
  const [policy,setPolicy]=useState(()=>migratedPolicy(loadScoreMatrixFormulaConfig()));
  const [revision,setRevision]=useState<number>();
  if(!user)return null;
  return <ScorecardReview key={user.id} portfolio={portfolio} stage={stage} fallbackPolicy={policy} revisionId={revision}
    onRevision={setRevision} onPolicy={setPolicy} onClose={()=>router.push(portfolio==="zerodha"?"/console/zerodha#india-workflow":"/console/indmoney-us")}/>;
}

