export type SidebarPolicy = {
    visible_ids: string[] | null;
    revision: number;
    can_manage: boolean;
};

export const SIDEBAR_POLICY_CHANGED = 'credx:sidebar-policy-changed';

export function isSidebarPolicy(value: unknown): value is SidebarPolicy {
    if (!value || typeof value !== 'object') return false;
    const policy = value as Partial<SidebarPolicy>;
    return typeof policy.can_manage === 'boolean' && Number.isSafeInteger(policy.revision)
        && (policy.visible_ids === null || (Array.isArray(policy.visible_ids)
            && policy.visible_ids.every((id) => typeof id === 'string')));
}

export type SidebarMode = 'inherit' | 'extra' | 'custom';
export type SidebarAccount = {id: number; email: string; username: string};
export type SidebarSettingsRecord = {
    mode: SidebarMode;
    visible_ids: string[] | null;
    global_ids: string[] | null;
    revision: number;
};
