type Assessment={eligible:boolean;simulation_only?:boolean;live_funds_verified?:boolean;orders_authorized?:boolean;requires_new_exact_approval?:boolean;revision_version?:string};
export function canReviewRevision(plan:{version:string;revision_parent?:string;execution_assessment?:Assessment}){
 const value=plan.execution_assessment;
 return !!plan.revision_parent&&value?.eligible===true&&value.simulation_only===true&&value.live_funds_verified===false&&value.orders_authorized===false&&value.requires_new_exact_approval===true&&value.revision_version===plan.version;
}
