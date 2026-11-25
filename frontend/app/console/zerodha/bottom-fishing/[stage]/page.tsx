import {notFound} from "next/navigation";
import {stages,type Stage} from "@/components/scorecards/bottomFishing/model";
import {StagePage} from "@/components/scorecards/bottomFishing/StagePage";

export default async function Page({params,searchParams}:{params:Promise<{stage:string}>;searchParams:Promise<{view?:string;record?:string}>}) {
  const {stage}=await params;
  const {view,record}=await searchParams;
  if(!stages.includes(stage as Stage) || (record && !/^[1-9]\d*$/.test(record))) notFound();
  return <StagePage stage={stage as Stage} view={view} record={record?Number(record):undefined}/>;
}
