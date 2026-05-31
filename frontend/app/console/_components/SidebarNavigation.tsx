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
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import type { IconType } from 'react-icons';
import {
    HiOutlineBookOpen,
    HiOutlineBriefcase,
    HiOutlineCube,
    HiOutlineTrendingUp,
    HiOutlineUser,
    HiOutlineViewGrid,
} from 'react-icons/hi';
import { URLs } from '@/lib/urls';

type NavigationItem = {
    id: string;
    name: string;
    href: string;
    icon: IconType;
};

type NavigationGroup = {
    id: string;
    name: string;
    icon: IconType;
    children: NavigationItem[];
};

type NavigationEntry = NavigationItem | NavigationGroup;

type SidebarNavigationProps = {
    pathname: string;
    userId?: number | null;
    onNavigate: () => void;
};

type SortableListeners = ReturnType<typeof useSortable>['listeners'];

type SortableNavigationRowProps = {
    isActive: (href: string) => boolean;
    isPortfolioActive: boolean;
    isPortfolioExpanded: boolean;
    isReordering: boolean;
    item: NavigationEntry;
    onNavigate: () => void;
    onTogglePortfolio: () => void;
};

const PORTFOLIO_CHILDREN: NavigationItem[] = [
    {
        id: 'portfolio-zerodha',
        name: 'Zerodha',
        href: URLs.routes.console.zerodha(),
        icon: HiOutlineTrendingUp,
    },
    {
        id: 'portfolio-indmoney-us',
        name: 'IndMoney US',
        href: URLs.routes.console.indmoneyUs(),
        icon: HiOutlineTrendingUp,
    },
    {
        id: 'portfolio-polymarket-bot',
        name: 'Polymarket Bot',
        href: URLs.routes.console.polymarketBot(),
        icon: HiOutlineTrendingUp,
    },
];

const DEFAULT_NAVIGATION: NavigationEntry[] = [
    {
        id: 'dashboard',
        name: 'Dashboard',
        href: URLs.routes.console.dashboard(),
        icon: HiOutlineViewGrid,
    },
    {
        id: 'runs',
        name: 'Runs',
        href: URLs.routes.console.runs(),
        icon: HiOutlineBriefcase,
    },
    {
        id: 'prompts',
        name: 'Prompts',
        href: URLs.routes.console.prompts(),
        icon: HiOutlineBookOpen,
    },
    {
        id: 'portfolio',
        name: 'Portfolio',
        icon: HiOutlineTrendingUp,
        children: PORTFOLIO_CHILDREN,
    },
    {
        id: 'apis',
        name: 'APIs',
        href: URLs.routes.console.apis(),
        icon: HiOutlineCube,
    },
    {
        id: 'google-sheets',
        name: 'Google Sheets',
        href: URLs.routes.console.googleSheets(),
        icon: HiOutlineViewGrid,
    },
    {
        id: 'profile',
        name: 'Profile',
        href: URLs.routes.profile.root(),
        icon: HiOutlineUser,
    },
];

const DEFAULT_NAVIGATION_ORDER = DEFAULT_NAVIGATION.map((item) => item.id);
const DEFAULT_NAVIGATION_ID_SET = new Set(DEFAULT_NAVIGATION_ORDER);
const PORTFOLIO_ROUTES = PORTFOLIO_CHILDREN.map((child) => child.href);
const SIDEBAR_ORDER_UPDATED_EVENT = 'investor:sidebar-order-updated';

function isNavigationGroup(item: NavigationEntry): item is NavigationGroup {
    return 'children' in item;
}

function buildStorageKey(userId?: number | null) {
    return `investor:console-sidebar-order:user:${userId ?? 'guest'}:v1`;
}

function reconcileNavigationOrder(order: string[]) {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const id of order) {
        if (!DEFAULT_NAVIGATION_ID_SET.has(id) || seen.has(id)) {
            continue;
        }

        normalized.push(id);
        seen.add(id);
    }

    for (const id of DEFAULT_NAVIGATION_ORDER) {
        if (!seen.has(id)) {
            normalized.push(id);
        }
    }

    return normalized;
}

function orderNavigation(order: string[]) {
    const orderedIds = reconcileNavigationOrder(order);
    const entriesById = new Map(DEFAULT_NAVIGATION.map((item) => [item.id, item]));

    return orderedIds
        .map((id) => entriesById.get(id))
        .filter((item): item is NavigationEntry => Boolean(item));
}

function readNavigationOrder(storageKey: string) {
    if (typeof window === 'undefined') {
        return DEFAULT_NAVIGATION_ORDER;
    }

    try {
        const raw = window.localStorage.getItem(storageKey);

        if (!raw) {
            return DEFAULT_NAVIGATION_ORDER;
        }

        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
            return reconcileNavigationOrder(parsed.filter((value): value is string => typeof value === 'string'));
        }
    } catch (error) {
        console.warn('Failed to restore sidebar order:', error);
    }

    return DEFAULT_NAVIGATION_ORDER;
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

function persistNavigationOrder(storageKey: string, order: string[]) {
    if (typeof window === 'undefined') {
        return;
    }

    const normalized = reconcileNavigationOrder(order);
    window.localStorage.setItem(storageKey, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(SIDEBAR_ORDER_UPDATED_EVENT, { detail: storageKey }));
}

function DragHandle({
    attributes,
    listeners,
    setActivatorNodeRef,
}: {
    attributes: DraggableAttributes;
    listeners?: SortableListeners;
    setActivatorNodeRef: (element: HTMLElement | null) => void;
}) {
    return (
        <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label="Drag to reorder navigation item"
            className="flex h-8 w-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-gray-400 transition hover:bg-white hover:text-gray-600 active:cursor-grabbing"
            {...attributes}
            {...listeners}
        >
            <GripVertical className="h-4 w-4" />
        </button>
    );
}

function SortableNavigationRow({
    isActive,
    isPortfolioActive,
    isPortfolioExpanded,
    isReordering,
    item,
    onNavigate,
    onTogglePortfolio,
}: SortableNavigationRowProps) {
    const {
        attributes,
        isDragging,
        listeners,
        setActivatorNodeRef,
        setNodeRef,
        transform,
        transition,
    } = useSortable({
        id: item.id,
        disabled: !isReordering,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const rowIsActive = isNavigationGroup(item) ? isPortfolioActive : isActive(item.href);
    const rowClassName = `flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition ${rowIsActive
        ? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-100'
        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
        } ${isDragging ? 'bg-white shadow-lg ring-1 ring-indigo-100' : ''} ${isReordering ? 'select-none' : ''}`;
    const iconClassName = `h-5 w-5 shrink-0 ${rowIsActive ? 'text-indigo-600' : 'text-gray-400'}`;

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={isDragging ? 'relative z-20' : undefined}
        >
            {isNavigationGroup(item) ? (
                <div className="space-y-1">
                    {isReordering ? (
                        <div className={rowClassName}>
                            <DragHandle
                                attributes={attributes}
                                listeners={listeners}
                                setActivatorNodeRef={setActivatorNodeRef}
                            />
                            <item.icon className={iconClassName} />
                            <span className="truncate">{item.name}</span>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={onTogglePortfolio}
                            className={rowClassName}
                        >
                            <item.icon className={iconClassName} />
                            <span className="truncate">{item.name}</span>
                            <span className="ml-auto text-gray-400">
                                {isPortfolioExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                ) : (
                                    <ChevronRight className="h-4 w-4" />
                                )}
                            </span>
                        </button>
                    )}

                    {!isReordering && isPortfolioExpanded ? (
                        <div className="ml-6 space-y-1 border-l border-gray-200 pl-3">
                            {item.children.map((child) => (
                                <Link
                                    key={child.id}
                                    href={child.href}
                                    onClick={onNavigate}
                                    className={`flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive(child.href)
                                        ? 'bg-indigo-50 text-indigo-600'
                                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                                        }`}
                                >
                                    <span className={`mr-2 text-xs ${isActive(child.href) ? 'text-indigo-500' : 'text-gray-300'}`}>
                                        •
                                    </span>
                                    {child.name}
                                </Link>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : isReordering ? (
                <div className={rowClassName}>
                    <DragHandle
                        attributes={attributes}
                        listeners={listeners}
                        setActivatorNodeRef={setActivatorNodeRef}
                    />
                    <item.icon className={iconClassName} />
                    <span className="truncate">{item.name}</span>
                </div>
            ) : (
                <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={rowClassName}
                >
                    <item.icon className={iconClassName} />
                    <span className="truncate">{item.name}</span>
                </Link>
            )}
        </div>
    );
}

export function SidebarNavigation({
    pathname,
    userId,
    onNavigate,
}: SidebarNavigationProps) {
    const [isReordering, setIsReordering] = useState(false);
    const [portfolioOpen, setPortfolioOpen] = useState(false);

    const storageKey = useMemo(() => buildStorageKey(userId), [userId]);
    const navigationOrder = useSyncExternalStore(
        (onStoreChange) => subscribeToNavigationOrder(storageKey, onStoreChange),
        () => readNavigationOrder(storageKey),
        () => DEFAULT_NAVIGATION_ORDER,
    );
    const navigation = useMemo(() => orderNavigation(navigationOrder), [navigationOrder]);

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

    const isActive = (href: string) => {
        if (href === URLs.routes.console.dashboard()) {
            return pathname === href;
        }

        if (PORTFOLIO_ROUTES.includes(href)) {
            return pathname === href || pathname.startsWith(`${href}/`);
        }

        return pathname.startsWith(href);
    };

    const isPortfolioActive = PORTFOLIO_ROUTES.some(
        (href) => pathname === href || pathname.startsWith(`${href}/`),
    );
    const isPortfolioExpanded = !isReordering && (portfolioOpen || isPortfolioActive);

    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        if (!over || active.id === over.id) {
            return;
        }

        const normalized = reconcileNavigationOrder(navigationOrder);
        const oldIndex = normalized.indexOf(String(active.id));
        const newIndex = normalized.indexOf(String(over.id));

        if (oldIndex === -1 || newIndex === -1) {
            return;
        }

        persistNavigationOrder(storageKey, arrayMove(normalized, oldIndex, newIndex));
    };

    return (
        <div className="space-y-3">
            <div className="px-2">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                        Navigation
                    </span>
                    <div className="flex items-center gap-2">
                        {isReordering ? (
                            <button
                                type="button"
                                onClick={() => persistNavigationOrder(storageKey, DEFAULT_NAVIGATION_ORDER)}
                                className="text-xs font-medium text-gray-500 transition hover:text-gray-700"
                            >
                                Reset
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => setIsReordering((current) => !current)}
                            className="rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 transition hover:border-gray-300 hover:text-gray-900"
                        >
                            {isReordering ? 'Done' : 'Reorder'}
                        </button>
                    </div>
                </div>
                {isReordering ? (
                    <p className="mt-2 text-xs leading-5 text-gray-500">
                        Drag the grip to move items up or down. Your order saves automatically for this account on this browser.
                    </p>
                ) : null}
            </div>

            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
            >
                <SortableContext
                    items={navigation.map((item) => item.id)}
                    strategy={verticalListSortingStrategy}
                >
                    <div className="space-y-1 overflow-y-auto px-2 pb-4">
                        {navigation.map((item) => (
                            <SortableNavigationRow
                                key={item.id}
                                item={item}
                                isActive={isActive}
                                isPortfolioActive={isPortfolioActive}
                                isPortfolioExpanded={isPortfolioExpanded}
                                isReordering={isReordering}
                                onNavigate={onNavigate}
                                onTogglePortfolio={() => setPortfolioOpen((current) => !current)}
                            />
                        ))}
                    </div>
                </SortableContext>
            </DndContext>
        </div>
    );
}
