"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiService } from "@/services/api";
import { formatUnknownError } from "@/lib/apiErrors";
import type { BullpenAutoLiveEventTrendsResponse, BullpenAutoLiveHistoryItem, BullpenAutoLiveHistoryPage } from "@/types/api";
import { BullpenRunHistoryContent } from "./BullpenRunHistoryContent";
import { BullpenHistoryPortfolio } from "./BullpenHistoryPortfolio";
export function BullpenRunHistoryScreen() {
 const router=useRouter(); const [page,setPage]=useState<BullpenAutoLiveHistoryPage|null>(null); const [trends,setTrends]=useState<BullpenAutoLiveEventTrendsResponse|null>(null); const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null);
 const load=useCallback(async(pageNumber=1)=>{setLoading(true);setError(null);try{const [p,t]=await Promise.all([apiService.getBullpenAutoLiveHistory({page:pageNumber,size:20}),apiService.getBullpenAutoLiveHistoryEventTrends()]);setPage(p);setTrends(t)}catch(cause){setError(`Run history is temporarily unavailable. ${formatUnknownError(cause)}`)}finally{setLoading(false)}},[]);
 useEffect(()=>{window.queueMicrotask(()=>void load())},[load]); const openRun=(run:BullpenAutoLiveHistoryItem)=>router.push(`/console/bullpen-ai/analyse-runs/${encodeURIComponent(run.id)}`);
 return <main className="min-h-screen bg-slate-100 p-4 md:p-8"><div className="mx-auto max-w-[96rem] space-y-6"><BullpenHistoryPortfolio /><BullpenRunHistoryContent page={page} trends={trends} loading={loading} trendsLoading={loading} error={error} trendsError={null} onRefresh={()=>void load(page?.page??1)} onPage={next=>void load(next)} onOpenRun={openRun} showFullScreen={false}/></div></main>;
}
