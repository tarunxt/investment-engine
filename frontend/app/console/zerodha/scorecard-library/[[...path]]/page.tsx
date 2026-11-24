import { notFound } from "next/navigation";
import { ScorecardLibrary } from "@/components/scorecards/ScorecardLibrary";

export default async function Page({params}: {params: Promise<{path?: string[]}>}) {
  const {path = []} = await params;
  if (path.length > 1 || (path[0] && !/^(create|rebalance|technical|threats|pairwise|custom-[a-f0-9]{32})$/.test(path[0]))) notFound();
  return <ScorecardLibrary screen={path[0] ?? "explore"} />;
}
