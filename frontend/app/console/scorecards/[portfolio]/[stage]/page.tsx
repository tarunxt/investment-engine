import { notFound } from "next/navigation";
import { ScorecardStandalone } from "@/app/console/_components/ScorecardStandalone";

export default async function ScorecardPage({params}:{params:Promise<{portfolio:string;stage:string}>}) {
  const {portfolio,stage}=await params;
  if(portfolio!=="zerodha"&&portfolio!=="indmoneyUs")notFound();
  if(stage!=="rebalance"&&stage!=="technical"&&stage!=="threats"&&stage!=="pairwise"&&stage!=="actionables"&&stage!=="source")notFound();
  return <ScorecardStandalone portfolio={portfolio} stage={stage}/>;
}

