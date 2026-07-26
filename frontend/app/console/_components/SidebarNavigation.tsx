'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
    DndContext,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DraggableAttributes,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    ChevronDown,
    ChevronRight,
    GripVertical,
} from 'lucide-react';

import type { User } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

import { SidebarThemeToggle } from './SidebarThemeToggle';
import {
    ACCOUNT_ACTIONS,
    ACCOUNT_NAVIGATION,
    SIDEBAR_SECTIONS,
    type NavigationBadge as NavigationBadgeType,
    type NavigationEntry,
    type NavigationGroup,
    type NavigationLeaf,
    type NavigationSection,
} from './sidebarNavigationConfig';
import {
    buildSidebarOrderStorageKey,
    collectEntrySectionIds,
    createDefaultSidebarOrder,
    findActiveGroupIds,
    isEntryActive,
    isLeafActive,
    isNavigationGroup,
    reconcileSidebarOrder,
    type SidebarOrder,
    orderNavigationSections,
} from './sidebarNavigationUtils';

type SidebarNavigationProps = {
    pathname: string;
    user?: User | null;
    userId?: number | null;
    onLogout?: () => Promise<void>;
    onNavigate: () => void;
};

type SortableListeners = ReturnType<typeof useSortable>['listeners'];
type NavigationOrderSnapshot = {
    raw: string | null;
    value: SidebarOrder;
};

type DragHandleProps = {
    attributes: DraggableAttributes;
    listeners?: SortableListeners;
    setActivatorNodeRef: (element: HTMLElement | null) => void;
    label: string;
};

type NavigationLeafLinkProps = {
    leaf: NavigationLeaf;
    active: boolean;
    onNavigate: () => void;
    depth?: 'root' | 'child';
};

type NavigationGroupRowProps = {
    active: boolean;
    expanded: boolean;
    group: NavigationGroup;
    onNavigate: () => void;
    onToggle: () => void;
    pathname: string;
};

type SortableNavigationEntryProps = {
    entry: NavigationEntry;
    expandedGroupIds: ReadonlySet<string>;
    isReordering: boolean;
    onNavigate: () => void;
    onToggleGroup: (groupId: string) => void;
    pathname: string;
    sectionLabel: string;
};

type SidebarSectionProps = {
    expandedGroupIds: ReadonlySet<string>;
    isReordering: boolean;
    onNavigate: () => void;
    onToggleGroup: (groupId: string) => void;
    pathname: string;
    section: NavigationSection;
};

type AccountFooterProps = {
    onLogout?: () => Promise<void>;
    onNavigate: () => void;
    pathname: string;
    user?: User | null;
};

type NavigationExpansionState = {
    pathname: string;
    expandedGroupId: string | null;
};

const SIDEBAR_ORDER_UPDATED_EVENT = 'investment-engine:sidebar-order-updated';
const navigationOrderSnapshotCache = new Map<string, NavigationOrderSnapshot>();

function cloneSidebarOrder(order: Record<string, readonly string[]>) {
    return Object.fromEntries(
        Object.entries(order).map(([sectionId, entryIds]) => [sectionId, [...entryIds]]),
    );
}

function readNavigationOrder(
    storageKey: string,
    defaultOrder: Record<string, readonly string[]>,
    entrySectionById: Readonly<Record<string, string>>,
) {
    const fallback = cloneSidebarOrder(defaultOrder);

    if (typeof window === 'undefined') {
        return fallback;
    }

    const raw = window.localStorage.getItem(storageKey);
    const cachedSnapshot = navigationOrderSnapshotCache.get(storageKey);

    if (cachedSnapshot && cachedSnapshot.raw === raw) {
        return cachedSnapshot.value;
    }

    if (!raw) {
        navigationOrderSnapshotCache.set(storageKey, {
            raw,
            value: fallback,
        });
        return fallback;
    }

    try {
        const parsed = JSON.parse(raw);
        const value = reconcileSidebarOrder(parsed, defaultOrder, entrySectionById);

        navigationOrderSnapshotCache.set(storageKey, { raw, value });
        return value;
    } catch (error) {
        console.warn('Failed to restore sidebar order:', error);
    }

    navigationOrderSnapshotCache.set(storageKey, {
        raw,
        value: fallback,
    });
    return fallback;
}

function subscribeToNavigationOrder(storageKey: string, onStoreChange: () => void) {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key === storageKey || event.key === null) {
            onStoreChange();
        }
    };

    const handleSidebarOrderUpdated = (event: Event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;

        if (detail === storageKey) {
            onStoreChange();
        }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(SIDEBAR_ORDER_UPDATED_EVENT, handleSidebarOrderUpdated);

    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(SIDEBAR_ORDER_UPDATED_EVENT, handleSidebarOrderUpdated);
    };
}

function persistNavigationOrder(
    storageKey: string,
    order: SidebarOrder,
    defaultOrder: Record<string, readonly string[]>,
    entrySectionById: Readonly<Record<string, string>>,
) {
    if (typeof window === 'undefined') {
        return;
    }

    const normalized = reconcileSidebarOrder(order, defaultOrder, entrySectionById);
    const raw = JSON.stringify(normalized);
    const cachedSnapshot = navigationOrderSnapshotCache.get(storageKey);

    if (cachedSnapshot?.raw === raw) {
        return;
    }

    navigationOrderSnapshotCache.set(storageKey, { raw, value: normalized });
    window.localStorage.setItem(storageKey, raw);
    window.dispatchEvent(new CustomEvent(SIDEBAR_ORDER_UPDATED_EVENT, { detail: storageKey }));
}

function getUserInitials(user?: User | null) {
    const name = user?.full_name?.trim();

    if (name) {
        const initials = name
            .split(/\s+/)
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('')
            .slice(0, 2);

        if (initials) {
            return initials;
        }
    }

    return user?.username?.[0]?.toUpperCase() || 'U';
}

function ReorderIcon({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
        >
            <path d="M12 2.75L16.25 7.75H7.75L12 2.75Z" fill="currentColor" />
            <path
                d="M5 10H19M5 12.5H19M5 15H19"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
            <path d="M12 21.25L7.75 16.25H16.25L12 21.25Z" fill="currentColor" />
        </svg>
    );
}

function NavigationBadge({ badge }: { badge: NavigationBadgeType }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em]',
                badge.variant === 'live'
                    ? 'border-destructive/30 bg-destructive/10 text-destructive'
                    : '',
                badge.variant === 'review'
                    ? 'border-sidebar-border bg-sidebar text-muted-foreground'
                    : '',
                badge.variant === 'direct'
                    ? 'hidden border-sidebar-border bg-transparent text-sidebar-foreground/70 min-[360px]:inline-flex'
                    : '',
                badge.variant === 'default'
                    ? 'border-sidebar-border bg-sidebar-accent text-sidebar-foreground/75'
                    : '',
            )}
        >
            {badge.label}
        </span>
    );
}

function DragHandle({
    attributes,
    listeners,
    setActivatorNodeRef,
    label,
}: DragHandleProps) {
    return (
        <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={label}
            className="flex h-8 w-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground transition hover:bg-sidebar hover:text-sidebar-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            {...attributes}
            {...listeners}
        >
            <GripVertical className="h-4 w-4" />
        </button>
    );
}

function NavigationLeafLink({
    leaf,
    active,
    onNavigate,
    depth = 'root',
}: NavigationLeafLinkProps) {
    const isChild = depth === 'child';

    return (
        <Link
            href={leaf.href}
            prefetch={false}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            title={leaf.title ?? leaf.name}
            className={cn(
                'group flex w-full items-center rounded-xl text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                isChild
                    ? 'gap-2 px-3 py-2.5'
                    : 'gap-3 px-3.5 py-3',
                active
                    ? 'bg-sidebar-accent text-sidebar-primary ring-1 ring-sidebar-border'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            )}
        >
            {isChild ? (
                <span
                    aria-hidden="true"
                    className={cn(
                        'mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        active ? 'bg-sidebar-primary' : 'bg-muted-foreground/45',
                    )}
                />
            ) : leaf.icon ? (
                <leaf.icon
                    className={cn(
                        'h-5 w-5 shrink-0',
                        active ? 'text-sidebar-primary' : 'text-muted-foreground',
                    )}
                />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{leaf.name}</span>
            {leaf.badge ? <NavigationBadge badge={leaf.badge} /> : null}
        </Link>
    );
}

function NavigationGroupRow({
    active,
    expanded,
    group,
    onNavigate,
    onToggle,
    pathname,
}: NavigationGroupRowProps) {
    const childrenId = `${group.id}-children`;

    return (
        <div className="space-y-1.5">
            <button
                type="button"
                aria-expanded={expanded}
                aria-controls={childrenId}
                title={group.name}
                onClick={onToggle}
                className={cn(
                    'flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                    active
                        ? 'bg-sidebar-accent text-sidebar-primary shadow-sm ring-1 ring-sidebar-border'
                        : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
            >
                <group.icon
                    className={cn(
                        'h-5 w-5 shrink-0',
                        active ? 'text-sidebar-primary' : 'text-muted-foreground',
                    )}
                />
                <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
                <span className={cn('shrink-0 text-muted-foreground', active ? 'text-sidebar-primary' : '')}>
                    {expanded ? (
                        <ChevronDown className="h-4 w-4" />
                    ) : (
                        <ChevronRight className="h-4 w-4" />
                    )}
                </span>
            </button>

            {expanded ? (
                <div
                    id={childrenId}
                    role="group"
                    aria-label={group.name}
                    className="ml-5 space-y-1 border-l border-sidebar-border/80 pl-3"
                >
                    {group.children.map((child) => (
                        <NavigationLeafLink
                            key={child.id}
                            leaf={child}
                            active={isLeafActive(pathname, child)}
                            onNavigate={onNavigate}
                            depth="child"
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function SortableNavigationEntry({
    entry,
    expandedGroupIds,
    isReordering,
    onNavigate,
    onToggleGroup,
    pathname,
    sectionLabel,
}: SortableNavigationEntryProps) {
    const {
        attributes,
        isDragging,
        listeners,
        setActivatorNodeRef,
        setNodeRef,
        transform,
        transition,
    } = useSortable({
        id: entry.id,
        disabled: !isReordering,
    });
    const active = isEntryActive(pathname, entry);
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const rowClassName = cn(
        'flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-sm font-medium transition',
        active
            ? 'bg-sidebar-accent text-sidebar-primary shadow-sm ring-1 ring-sidebar-border'
            : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        isDragging ? 'bg-sidebar shadow-lg ring-1 ring-sidebar-border' : '',
        isReordering ? 'select-none' : '',
    );

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={isDragging ? 'relative z-20' : undefined}
        >
            {isReordering ? (
                <div className={rowClassName}>
                    <DragHandle
                        attributes={attributes}
                        listeners={listeners}
                        setActivatorNodeRef={setActivatorNodeRef}
                        label={`Drag to reorder ${entry.name} within ${sectionLabel}`}
                    />
                    {entry.icon ? (
                        <entry.icon
                            className={cn(
                                'h-5 w-5 shrink-0',
                                active ? 'text-sidebar-primary' : 'text-muted-foreground',
                            )}
                        />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </div>
            ) : isNavigationGroup(entry) ? (
                <NavigationGroupRow
                    active={active}
                    expanded={expandedGroupIds.has(entry.id)}
                    group={entry}
                    onNavigate={onNavigate}
                    onToggle={() => onToggleGroup(entry.id)}
                    pathname={pathname}
                />
            ) : (
                <NavigationLeafLink
                    leaf={entry}
                    active={active}
                    onNavigate={onNavigate}
                />
            )}
        </div>
    );
}

function SidebarSection({
    expandedGroupIds,
    isReordering,
    onNavigate,
    onToggleGroup,
    pathname,
    section,
}: SidebarSectionProps) {
    const headingId = `${section.id}-heading`;

    return (
        <section aria-labelledby={headingId} className="space-y-2">
            <div className="px-1">
                <h2
                    id={headingId}
                    className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
                >
                    {section.label}
                </h2>
            </div>
            <SortableContext
                items={section.entries.map((entry) => entry.id)}
                strategy={verticalListSortingStrategy}
            >
                <div className="space-y-1.5">
                    {section.entries.map((entry) => (
                        <SortableNavigationEntry
                            key={entry.id}
                            entry={entry}
                            expandedGroupIds={expandedGroupIds}
                            isReordering={isReordering}
                            onNavigate={onNavigate}
                            onToggleGroup={onToggleGroup}
                            pathname={pathname}
                            sectionLabel={section.label}
                        />
                    ))}
                </div>
            </SortableContext>
        </section>
    );
}

function AccountFooter({
    onLogout,
    onNavigate,
    pathname,
    user,
}: AccountFooterProps) {
    const displayName = user?.full_name || user?.username || 'User';
    const LogoutIcon = ACCOUNT_ACTIONS.logout.icon;

    return (
        <div className="border-t border-sidebar-border/80 pt-4">
            <div className="px-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Account
                </h2>
            </div>

            <div className="mx-3 mt-3 rounded-2xl border border-sidebar-border bg-sidebar-accent/80 p-3">
                <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-linear-to-r from-indigo-600 to-purple-600 text-sm font-semibold text-white">
                        {getUserInitials(user)}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-sidebar-accent-foreground">
                            {displayName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                            {user?.email}
                        </p>
                    </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                    {ACCOUNT_NAVIGATION.map((item) => (
                        <NavigationLeafLink
                            key={item.id}
                            leaf={item}
                            active={isLeafActive(pathname, item)}
                            onNavigate={onNavigate}
                        />
                    ))}
                </div>
            </div>

            <div className="mt-3">
                <SidebarThemeToggle />
            </div>

            {onLogout ? (
                <div className="px-3 pt-3">
                    <button
                        type="button"
                        onClick={() => {
                            onNavigate();
                            void onLogout();
                        }}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-sidebar-border bg-sidebar px-3 py-2.5 text-sm font-semibold text-sidebar-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                    >
                        <LogoutIcon className="h-4 w-4" />
                        {ACCOUNT_ACTIONS.logout.label}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export function SidebarNavigation({
    pathname,
    user,
    userId,
    onLogout,
    onNavigate,
}: SidebarNavigationProps) {
    const [isReordering, setIsReordering] = useState(false);
    const defaultOrder = useMemo(() => createDefaultSidebarOrder(SIDEBAR_SECTIONS), []);
    const entrySectionById = useMemo(() => collectEntrySectionIds(SIDEBAR_SECTIONS), []);
    const storageKey = useMemo(() => buildSidebarOrderStorageKey(userId), [userId]);
    const navigationOrder = useSyncExternalStore(
        (onStoreChange) => subscribeToNavigationOrder(storageKey, onStoreChange),
        () => readNavigationOrder(storageKey, defaultOrder, entrySectionById),
        () => cloneSidebarOrder(defaultOrder),
    );
    const sections = useMemo(
        () => orderNavigationSections(SIDEBAR_SECTIONS, navigationOrder),
        [navigationOrder],
    );
    const activeGroupId = useMemo(
        () => findActiveGroupIds(pathname, sections)[0] ?? null,
        [pathname, sections],
    );
    const [navigationExpansion, setNavigationExpansion] = useState<NavigationExpansionState>(
        () => ({
            pathname,
            expandedGroupId: activeGroupId,
        }),
    );
    const expandedGroupId = navigationExpansion.pathname === pathname
        ? navigationExpansion.expandedGroupId
        : activeGroupId;
    const expandedGroupIds = useMemo<ReadonlySet<string>>(
        () => new Set(expandedGroupId ? [expandedGroupId] : []),
        [expandedGroupId],
    );

    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 6,
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 120,
                tolerance: 6,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        if (!over || active.id === over.id) {
            return;
        }

        const activeSectionId = entrySectionById[String(active.id)];
        const overSectionId = entrySectionById[String(over.id)];

        if (!activeSectionId || activeSectionId !== overSectionId) {
            return;
        }

        const currentSectionOrder = navigationOrder[activeSectionId] ?? defaultOrder[activeSectionId];
        const oldIndex = currentSectionOrder.indexOf(String(active.id));
        const newIndex = currentSectionOrder.indexOf(String(over.id));

        if (oldIndex === -1 || newIndex === -1) {
            return;
        }

        persistNavigationOrder(
            storageKey,
            {
                ...navigationOrder,
                [activeSectionId]: arrayMove(currentSectionOrder, oldIndex, newIndex),
            },
            defaultOrder,
            entrySectionById,
        );
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Navigation
                    </span>
                    <div className="flex items-center gap-2">
                        {isReordering ? (
                            <button
                                type="button"
                                onClick={() => persistNavigationOrder(storageKey, cloneSidebarOrder(defaultOrder), defaultOrder, entrySectionById)}
                                className="text-xs font-medium text-muted-foreground transition hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                            >
                                Reset
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => setIsReordering((current) => !current)}
                            aria-label={isReordering ? 'Finish reordering navigation' : 'Reorder navigation'}
                            title={isReordering ? 'Finish reordering navigation' : 'Reorder navigation'}
                            className={cn(
                                'rounded-full border border-sidebar-border text-xs font-semibold text-sidebar-foreground/75 transition hover:border-sidebar-ring hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                                isReordering
                                    ? 'px-3 py-1.5'
                                    : 'flex h-9 w-9 items-center justify-center p-0',
                            )}
                        >
                            {isReordering ? 'Done' : <ReorderIcon className="h-5 w-5" />}
                        </button>
                    </div>
                </div>
                {isReordering ? (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        Drag the handle to reorder items within each section. Your order saves automatically for this account on this browser.
                    </p>
                ) : null}
            </div>

            <div className="mt-4 min-h-0 flex-1">
                <nav aria-label="Console navigation" className="h-full overflow-y-auto px-2 pb-4">
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <div className="space-y-5 pr-1">
                            {sections.map((section) => (
                                <SidebarSection
                                    key={section.id}
                                    expandedGroupIds={expandedGroupIds}
                                    isReordering={isReordering}
                                    onNavigate={onNavigate}
                                    onToggleGroup={(groupId) => {
                                        setNavigationExpansion({
                                            pathname,
                                            expandedGroupId: expandedGroupId === groupId
                                                ? null
                                                : groupId,
                                        });
                                    }}
                                    pathname={pathname}
                                    section={section}
                                />
                            ))}
                        </div>
                    </DndContext>
                </nav>
            </div>

            <div className="shrink-0 pb-2">
                <AccountFooter
                    onLogout={onLogout}
                    onNavigate={onNavigate}
                    pathname={pathname}
                    user={user}
                />
            </div>
        </div>
    );
}
