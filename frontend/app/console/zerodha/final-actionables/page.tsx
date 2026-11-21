import { ScorecardStandalone } from "@/app/console/_components/ScorecardStandalone";
import { FinalActionablesConsole } from '@/app/console/_components/FinalActionablesConsole';

export default async function ZerodhaFinalActionablesPage({searchParams}:{searchParams:Promise<{history?:string}>}) {
  if((await searchParams).history!=="1") return <ScorecardStandalone portfolio="zerodha" stage="actionables"/>;
  return <FinalActionablesConsole portfolio="zerodha" market="india" />;
}
