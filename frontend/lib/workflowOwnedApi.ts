import { requireWorkflowOwner, type WorkflowOwner } from "./workflowOwnerLifetime";

/** A captured runtime cannot begin another request or consume a response after owner teardown. */
export function workflowOwnedApi<T extends object>(api: T, owner: WorkflowOwner | null): T {
  return new Proxy(api, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        requireWorkflowOwner(owner);
        const result = Reflect.apply(member, target, args);
        if (!(result instanceof Promise)) return result;
        return result.then(value => { requireWorkflowOwner(owner); return value; }, error => { requireWorkflowOwner(owner); throw error; });
      };
    },
  });
}
