/** Private P1 module caches share one authenticated owner generation. No tokens or drafts. */
export type WorkflowOwner = Readonly<{ id: number; generation: number }>;
let current: WorkflowOwner | null = null;
let generation = 0;
const invalidators = new Set<() => void>();
export function setWorkflowOwner(id: number | null) {
  if (current?.id === id || (id === null && current === null)) return;
  generation += 1;
  current = id !== null && Number.isSafeInteger(id) && id > 0 ? { id, generation } : null;
  invalidators.forEach(clear => clear());
}
export function captureWorkflowOwner() { return current; }
export function isCurrentWorkflowOwner(owner: WorkflowOwner | null) { return owner !== null && owner === current; }
export function onWorkflowOwnerInvalidated(clear: () => void) { invalidators.add(clear); return () => { invalidators.delete(clear); }; }
export function requireWorkflowOwner(owner: WorkflowOwner | null = current) {
  if (!isCurrentWorkflowOwner(owner)) throw new Error("Workflow owner changed; reopen this section to load current saved data.");
  return owner as WorkflowOwner;
}
