"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUnknownError } from "@/lib/apiErrors";
import { formatApiTimestamp } from "@/lib/datetime";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type { Bullpen008Run, Bullpen008StageOutput } from "@/types/api";
import { BullpenAutoRunStageOutputDialog } from "../../../bullpen-ai/_components/BullpenAutoRunStageOutputDialog";

export function Bullpen008RunDetailClient({ runId }: { runId: string }) {
  const [run, setRun] = useState<Bullpen008Run | null>(null);
  const [selectedStage, setSelectedStage] = useState<Bullpen008StageOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiService.getBullpen008Run(runId, { signal: controller.signal }).then(setRun).catch((reason) => {
      if (!controller.signal.aborted) setError(`The Bullpen 008 run could not be loaded. ${formatUnknownError(reason)}`);
    });
    return () => controller.abort();
  }, [runId]);

  if (error) return <div role="alert" className="m-6 rounded-3xl border border-rose-200 bg-rose-50 p-5 text-rose-800"><AlertTriangle className="mr-2 inline h-4 w-4" />{error}</div>;
  if (!run) return <div className="flex min-h-64 items-center justify-center text-sm text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading isolated 008 run…</div>;
  const openStage = async (stageNumber: number) => {
    try {
      setSelectedStage(await apiService.getBullpen008Stage(runId, stageNumber));
    } catch (reason) {
      setError(
        `The immutable Stage ${stageNumber} record could not be loaded. ${formatUnknownError(reason)}`,
      );
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <Button variant="outline" asChild><Link href={URLs.routes.console.bullpen008()}><ArrowLeft className="mr-2 h-4 w-4" />Bullpen 008</Link></Button>
      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader><p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Bullpen 008 · immutable run</p><CardTitle>{run.id}</CardTitle><CardDescription>{run.summary}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">Status</p><p className="mt-1 font-semibold capitalize">{run.status}</p></div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">Started</p><p className="mt-1 font-semibold">{formatApiTimestamp(run.started_at)}</p></div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">Profile</p><p className="mt-1 font-semibold">{run.workflow_profile}</p></div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs text-amber-700">Execution</p><p className="mt-1 font-semibold text-amber-900">Shadow · no orders</p></div>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {run.stages.map((stage) => <button key={stage.stage_number} type="button" onClick={() => void openStage(stage.stage_number)} className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-sky-300 hover:shadow-md"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stage {stage.stage_number}</p><div className="mt-2 flex items-center justify-between gap-3"><h2 className="font-semibold text-slate-950">{stage.stage_name}</h2><span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold capitalize">{stage.status}</span></div><p className="mt-3 line-clamp-2 text-sm text-slate-600">{stage.pass_condition}</p><p className="mt-3 text-xs text-slate-500">{stage.duration_seconds.toFixed(2)}s · {stage.stage_version}</p></button>)}
      </div>
      {selectedStage ? <BullpenAutoRunStageOutputDialog stageTitle={`Stage ${selectedStage.stage_number}: ${selectedStage.stage_name}`} stageDetail={`${selectedStage.status.toUpperCase()} · Pass condition: ${selectedStage.pass_condition}`} eyebrow="Bullpen 008 immutable stage record" outputLabel="Stage record" recordPageSize={25} deferRawJson outputs={{ inputs: selectedStage.inputs, calculations: selectedStage.calculations, outputs: selectedStage.outputs, rejections: selectedStage.rejections, warnings: selectedStage.warnings, provenance: selectedStage.provenance, start_time: selectedStage.started_at, end_time: selectedStage.completed_at, duration_seconds: selectedStage.duration_seconds, stage_version: selectedStage.stage_version, output_hash: selectedStage.output_hash }} onClose={() => setSelectedStage(null)} /> : null}
    </div>
  );
}
