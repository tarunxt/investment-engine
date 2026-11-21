import { ScorecardStandalone } from "@/app/console/_components/ScorecardStandalone";
import { PortfolioRebalanceConsole } from '@/app/console/_components/PortfolioRebalanceConsole';

export default async function ZerodhaRebalancePage({searchParams}:{searchParams:Promise<{history?:string}>}) {
  if((await searchParams).history!=="1") return <ScorecardStandalone portfolio="zerodha" stage="rebalance"/>;
  return <PortfolioRebalanceConsole portfolio="zerodha" market="india" />;
}
