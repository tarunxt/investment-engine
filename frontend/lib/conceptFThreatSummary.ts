import type {ThreatSource} from './conceptFSavedThreats';
import {countThreatSeverities} from '@/app/console/dashboard/_components/dashboardOverviewUtils';
/** Preserve the original severity-cell rule, never reinterpret it as unique
 * risks, current portfolio membership or permission to execute. */
export function savedSeveritySummary(source:ThreatSource){
 if(source.source_scope!=='owned_historical_model_output_not_current_portfolio_risk'||source.status!=='completed'||source.parse_state!=='parsed_report'||!source.report)return null;
 const counts=countThreatSeverities(source.report.tables),total=Object.values(counts).reduce((a,b)=>a+b,0);
 return total>0?{...counts,total}:null;
}
