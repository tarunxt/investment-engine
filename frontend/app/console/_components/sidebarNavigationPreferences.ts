import { SIDEBAR_SECTIONS } from './sidebarNavigationConfig';

export type NavigationNameOverrides = Record<string, string>;
export type NavigationChildOrder = Record<string, string[]>;

type NavigationNamesSnapshot = {
    raw: string | null;
    value: NavigationNameOverrides;
};

type NavigationChildOrderSnapshot = {
    raw: string | null;
    value: NavigationChildOrder;
};

const SIDEBAR_NAMES_UPDATED_EVENT = 'investment-engine:sidebar-names-updated';
const SIDEBAR_CHILD_ORDER_UPDATED_EVENT = 'investment-engine:sidebar-child-order-updated';
const navigationNamesSnapshotCache = new Map<string, NavigationNamesSnapshot>();
const navigationChildOrderSnapshotCache = new Map<string, NavigationChildOrderSnapshot>();

export const EMPTY_NAVIGATION_NAME_OVERRIDES: NavigationNameOverrides = {};

export const DEFAULT_NAVIGATION_NAMES = Object.fromEntries(
    SIDEBAR_SECTIONS.flatMap((section) => [
        [`section:${section.id}`, section.label],
        ...section.entries.flatMap((entry) => [
            [`${entry.type === 'group' ? 'folder' : 'item'}:${entry.id}`, entry.name],
            ...(entry.type === 'group'
                ? entry.children.map((child) => [`item:${child.id}`, child.name])
                : []),
        ]),
    ]),
) as Record<string, string>;

export function buildSidebarNamesStorageKey(userId?: number | null) {
    return `investment-engine:console-sidebar-names:user:${userId ?? 'guest'}:v1`;
}

export function buildSidebarChildOrderStorageKey(userId?: number | null) {
    return `investment-engine:console-sidebar-child-order:user:${userId ?? 'guest'}:v1`;
}

export function createDefaultChildOrder() {
    return Object.fromEntries(
        SIDEBAR_SECTIONS.flatMap((section) => section.entries.flatMap((entry) => (
            entry.type === 'group'
                ? [[entry.id, entry.children.map((child) => child.id)]]
                : []
        ))),
    ) as NavigationChildOrder;
}

function cloneOrder(order: Record<string, readonly string[]>) {
    return Object.fromEntries(
        Object.entries(order).map(([containerId, entryIds]) => [containerId, [...entryIds]]),
    );
}

function reconcileChildOrder(
    storedValue: unknown,
    defaultOrder: NavigationChildOrder,
): NavigationChildOrder {
    const stored = storedValue && typeof storedValue === 'object' && !Array.isArray(storedValue)
        ? storedValue as Record<string, unknown>
        : {};

    return Object.fromEntries(Object.entries(defaultOrder).map(([groupId, defaultIds]) => {
        const allowed = new Set(defaultIds);
        const seen = new Set<string>();
        const candidate = Array.isArray(stored[groupId]) ? stored[groupId] : [];
        const ids = candidate.filter((id): id is string => {
            if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) {
                return false;
            }

            seen.add(id);
            return true;
        });

        return [groupId, [...ids, ...defaultIds.filter((id) => !seen.has(id))]];
    }));
}

export function readNavigationNameOverrides(storageKey: string): NavigationNameOverrides {
    if (typeof window === 'undefined') {
        return EMPTY_NAVIGATION_NAME_OVERRIDES;
    }

    const raw = window.localStorage.getItem(storageKey);
    const cachedSnapshot = navigationNamesSnapshotCache.get(storageKey);

    if (cachedSnapshot?.raw === raw) {
        return cachedSnapshot.value;
    }

    try {
        const parsed = JSON.parse(raw ?? '{}');

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            navigationNamesSnapshotCache.set(storageKey, {
                raw,
                value: EMPTY_NAVIGATION_NAME_OVERRIDES,
            });
            return EMPTY_NAVIGATION_NAME_OVERRIDES;
        }

        const value = Object.fromEntries(
            Object.entries(parsed)
                .filter((entry): entry is [string, string] => (
                    typeof entry[1] === 'string' && entry[1].trim().length > 0
                ))
                .map(([key, name]) => [key, name.trim().slice(0, 48)]),
        );
        navigationNamesSnapshotCache.set(storageKey, { raw, value });
        return value;
    } catch (error) {
        console.warn('Failed to restore sidebar names:', error);
        navigationNamesSnapshotCache.set(storageKey, {
            raw,
            value: EMPTY_NAVIGATION_NAME_OVERRIDES,
        });
        return EMPTY_NAVIGATION_NAME_OVERRIDES;
    }
}

export function subscribeToNavigationNames(storageKey: string, onStoreChange: () => void) {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key === storageKey || event.key === null) {
            onStoreChange();
        }
    };
    const handleNamesUpdated = (event: Event) => {
        if (event instanceof CustomEvent && event.detail === storageKey) {
            onStoreChange();
        }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(SIDEBAR_NAMES_UPDATED_EVENT, handleNamesUpdated);

    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(SIDEBAR_NAMES_UPDATED_EVENT, handleNamesUpdated);
    };
}

export function persistNavigationNameOverrides(
    storageKey: string,
    value: NavigationNameOverrides,
) {
    if (typeof window === 'undefined') {
        return;
    }

    const raw = JSON.stringify(value);
    navigationNamesSnapshotCache.set(storageKey, { raw, value });
    window.localStorage.setItem(storageKey, raw);
    window.dispatchEvent(new CustomEvent(SIDEBAR_NAMES_UPDATED_EVENT, { detail: storageKey }));
}

export function readNavigationChildOrder(
    storageKey: string,
    defaultOrder: NavigationChildOrder,
): NavigationChildOrder {
    const fallback = cloneOrder(defaultOrder);

    if (typeof window === 'undefined') {
        return fallback;
    }

    const raw = window.localStorage.getItem(storageKey);
    const cachedSnapshot = navigationChildOrderSnapshotCache.get(storageKey);

    if (cachedSnapshot?.raw === raw) {
        return cachedSnapshot.value;
    }

    try {
        const value = reconcileChildOrder(JSON.parse(raw ?? '{}'), defaultOrder);
        navigationChildOrderSnapshotCache.set(storageKey, { raw, value });
        return value;
    } catch (error) {
        console.warn('Failed to restore sidebar child order:', error);
        navigationChildOrderSnapshotCache.set(storageKey, { raw, value: fallback });
        return fallback;
    }
}

export function subscribeToNavigationChildOrder(
    storageKey: string,
    onStoreChange: () => void,
) {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key === storageKey || event.key === null) {
            onStoreChange();
        }
    };
    const handleOrderUpdated = (event: Event) => {
        if (event instanceof CustomEvent && event.detail === storageKey) {
            onStoreChange();
        }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(SIDEBAR_CHILD_ORDER_UPDATED_EVENT, handleOrderUpdated);

    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(SIDEBAR_CHILD_ORDER_UPDATED_EVENT, handleOrderUpdated);
    };
}

export function persistNavigationChildOrder(
    storageKey: string,
    order: NavigationChildOrder,
    defaultOrder: NavigationChildOrder,
) {
    if (typeof window === 'undefined') {
        return;
    }

    const value = reconcileChildOrder(order, defaultOrder);
    const raw = JSON.stringify(value);
    navigationChildOrderSnapshotCache.set(storageKey, { raw, value });
    window.localStorage.setItem(storageKey, raw);
    window.dispatchEvent(new CustomEvent(SIDEBAR_CHILD_ORDER_UPDATED_EVENT, { detail: storageKey }));
}
