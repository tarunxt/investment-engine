/** Navigation progress only. Financial/connection milestones remain server-owned. */
export const onboardingSteps=['modules','connection','snapshot','research','plan'] as const;
export type OnboardingStep=typeof onboardingSteps[number];
export function progressKey(owner:string){return `credx:onboarding:v1:${encodeURIComponent(owner)}`;}
export function readProgress(raw:string|null,owner:string):OnboardingStep{
 try{const value=JSON.parse(raw??'null');return value?.owner===owner&&value.schema===1&&onboardingSteps.includes(value.step)?value.step:'modules';}catch{return 'modules';}
}
export function progressValue(owner:string,step:OnboardingStep){return JSON.stringify({schema:1,owner,step});}
export function onboardingDestination(module:string,step:OnboardingStep){
 if(step==='modules')return '/console/profile/preferences#modules';
 if(step==='connection')return '/console/profile/connections';
 if(module==='indmoney_us')return '/console/indmoney-us'+(step==='snapshot'?'/portfolio':step==='research'?'/research':'/plans');
 if(module==='zerodha_rebalance')return step==='snapshot'?'/console/zerodha/portfolio':step==='research'?'/console/zerodha/research':'/console/zerodha/plans';
 return null;
}
