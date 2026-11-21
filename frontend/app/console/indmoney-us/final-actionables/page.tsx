import { ScorecardStandalone } from "@/app/console/_components/ScorecardStandalone";
import { FinalActionablesConsole } from '@/app/console/_components/FinalActionablesConsole';

export default async function IndMoneyUsFinalActionablesPage({searchParams}:{searchParams:Promise<{history?:string}>}) {
  if((await searchParams).history!=="1") return <ScorecardStandalone portfolio="indmoneyUs" stage="actionables"/>;
  return <FinalActionablesConsole portfolio="indmoneyUs" market="us" />;
}
