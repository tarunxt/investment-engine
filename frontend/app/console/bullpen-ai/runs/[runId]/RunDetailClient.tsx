"use client";

import { useParams } from "next/navigation";

import { BullpenRunDetailScreen } from "../../_components/BullpenAutoRunScheduleCard";

export function RunDetailClient() {
  const params = useParams<{ runId: string | string[] }>();
  const runId = Array.isArray(params.runId) ? params.runId[0] : params.runId;

  return <BullpenRunDetailScreen runId={runId ?? ""} />;
}
