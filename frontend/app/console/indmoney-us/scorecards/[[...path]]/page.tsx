import { notFound } from "next/navigation";
import { PortfolioWorkflowSlot } from "@/app/console/_components/WorkflowSurfaceSlots";
import { scorecardPath } from "@/lib/scorecardNavigation";

export default async function ScorecardsPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const screen = scorecardPath((await params).path);
  if (!screen) notFound();
  return <PortfolioWorkflowSlot market="indmoneyUs" scorecards={screen} />;
}
