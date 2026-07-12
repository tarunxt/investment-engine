import type {
    NavigationEntry,
    NavigationGroup,
    NavigationLeaf,
    NavigationLeafMatchMode,
    NavigationSection,
} from './sidebarNavigationConfig';

export type SidebarOrder = Record<string, string[]>;
export type SidebarOrderDefaults = Readonly<Record<string, readonly string[]>>;

function normalizePath(path: string) {
    if (path === '/') {
        return path;
    }

    return path.replace(/\/+$/, '');
}

function cloneSidebarOrder(order: SidebarOrderDefaults | SidebarOrder) {
    return Object.fromEntries(
        Object.entries(order).map(([sectionId, entryIds]) => [sectionId, [...entryIds]]),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildSidebarOrderStorageKey(userId?: number | null) {
    return `investment-engine:console-sidebar-order:user:${userId ?? 'guest'}:v2`;
}

export function isNavigationGroup(entry: NavigationEntry): entry is NavigationGroup {
    return entry.type === 'group';
}

export function createDefaultSidebarOrder(sections: readonly NavigationSection[]) {
    return Object.fromEntries(
        sections.map((section) => [section.id, section.entries.map((entry) => entry.id)]),
    );
}

export function collectEntrySectionIds(sections: readonly NavigationSection[]) {
    return Object.fromEntries(
        sections.flatMap((section) => section.entries.map((entry) => [entry.id, section.id])),
    );
}

export function collectLeafEntries(sections: readonly NavigationSection[]) {
    return sections.flatMap((section) => (
        section.entries.flatMap((entry) => (
            isNavigationGroup(entry) ? entry.children : [entry]
        ))
    ));
}

export function reconcileSidebarOrder(
    storedValue: unknown,
    defaultOrder: SidebarOrderDefaults,
    entrySectionById: Readonly<Record<string, string>>,
) {
    const fallback = cloneSidebarOrder(defaultOrder);

    if (!isRecord(storedValue)) {
        return fallback;
    }

    return Object.fromEntries(
        Object.entries(defaultOrder).map(([sectionId, defaultEntryIds]) => {
            const storedSectionValue = storedValue[sectionId];
            const storedEntryIds = Array.isArray(storedSectionValue)
                ? storedSectionValue.filter((entryId): entryId is string => typeof entryId === 'string')
                : [];
            const seen = new Set<string>();
            const orderedEntryIds: string[] = [];

            for (const entryId of storedEntryIds) {
                if (entrySectionById[entryId] !== sectionId || seen.has(entryId)) {
                    continue;
                }

                orderedEntryIds.push(entryId);
                seen.add(entryId);
            }

            for (const defaultEntryId of defaultEntryIds) {
                if (seen.has(defaultEntryId)) {
                    continue;
                }

                orderedEntryIds.push(defaultEntryId);
            }

            return [sectionId, orderedEntryIds];
        }),
    );
}

export function orderNavigationSections(
    sections: readonly NavigationSection[],
    order: SidebarOrder,
) {
    return sections.map((section) => {
        const entriesById = new Map(section.entries.map((entry) => [entry.id, entry]));
        const orderedEntryIds = order[section.id] ?? section.entries.map((entry) => entry.id);
        const orderedEntries = orderedEntryIds
            .map((entryId) => entriesById.get(entryId))
            .filter((entry): entry is NavigationEntry => Boolean(entry));

        return {
            ...section,
            entries: orderedEntries,
        };
    });
}

export function isRouteActive(
    pathname: string,
    href: string,
    matchMode: NavigationLeafMatchMode = 'prefix',
) {
    const normalizedPathname = normalizePath(pathname);
    const normalizedHref = normalizePath(href);

    if (matchMode === 'exact') {
        return normalizedPathname === normalizedHref;
    }

    return normalizedPathname === normalizedHref
        || normalizedPathname.startsWith(`${normalizedHref}/`);
}

export function isLeafActive(pathname: string, leaf: NavigationLeaf) {
    return isRouteActive(pathname, leaf.href, leaf.matchMode);
}

export function isEntryActive(pathname: string, entry: NavigationEntry) {
    if (isNavigationGroup(entry)) {
        return entry.children.some((child) => isLeafActive(pathname, child));
    }

    return isLeafActive(pathname, entry);
}

export function findActiveGroupIds(
    pathname: string,
    sections: readonly NavigationSection[],
) {
    return sections.flatMap((section) => (
        section.entries.flatMap((entry) => (
            isNavigationGroup(entry) && isEntryActive(pathname, entry) ? [entry.id] : []
        ))
    ));
}
