import { Bullpen008RunDetailClient } from "./Bullpen008RunDetailClient";

export const dynamic = "force-dynamic";

export default async function Bullpen008RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <Bullpen008RunDetailClient runId={runId} />;
}
