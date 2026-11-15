import { onWorkflowOwnerInvalidated } from "./workflowOwnerLifetime";
let active: symbol | null = null;
onWorkflowOwnerInvalidated(() => { active = null; });
/** Broker connection state is shared, so only one UI may interpret its completion. */
export function acquireZerodhaLogin() {
  if (active) return null;
  const ticket = Symbol("zerodha-login");
  active = ticket;
  return () => { if (active === ticket) active = null; };
}
