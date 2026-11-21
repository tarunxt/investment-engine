import { ScorecardStandalone } from "@/app/console/_components/ScorecardStandalone";
import { PortfolioRebalanceConsole } from '@/app/console/_components/PortfolioRebalanceConsole';

export default async function IndMoneyUsRebalancePage({searchParams}:{searchParams:Promise<{history?:string}>}) {
  if((await searchParams).history!=="1") return <ScorecardStandalone portfolio="indmoneyUs" stage="rebalance"/>;
  return <PortfolioRebalanceConsole historyOnly portfolio="indmoneyUs" market="us" />;
}
