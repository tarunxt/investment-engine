"use client";
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_NAVIGATION_NAMES } from './sidebarNavigationPreferences';
import { isEntryActive, isNavigationGroup } from './sidebarNavigationUtils';
import { NavigationGroupRow, NavigationLeafLink, type DragHandleProps, type SortableNavigationChildProps, type SortableNavigationEntryProps, type SidebarSectionProps } from './SidebarNavigation';
import {
    DndContext,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    closestCenter,
    useSensor,
    useSensors,
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
const NAVIGATION_FOCUS_OFFSET = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar';
const NAVIGATION_ROW = 'flex min-h-10 w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition';
const IDLE_ROW = 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';
const ITEM_OPTIONS = 'rounded-md px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-sidebar hover:text-sidebar-foreground';
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
            className={cn('flex h-8 w-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground transition hover:bg-sidebar hover:text-sidebar-foreground active:cursor-grabbing', NAVIGATION_FOCUS_OFFSET)}
            {...attributes}
            {...listeners}
        >
            <GripVertical className="h-4 w-4" />
        </button>
    );
}

function SortableNavigationChild({
    child,
    groupName,
    onContextMenu,
}: SortableNavigationChildProps) {
    const {
        attributes,
        isDragging,
        listeners,
        setActivatorNodeRef,
        setNodeRef,
        transform,
        transition,
    } = useSortable({ id: child.id });

    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className={cn(
                'flex items-center gap-2 rounded-xl border border-transparent bg-sidebar-accent/45 px-2 py-1.5 text-sm text-sidebar-foreground/75',
                isDragging ? 'relative z-20 border-sidebar-border bg-sidebar shadow-lg' : '',
            )}
        >
            <DragHandle
                attributes={attributes}
                listeners={listeners}
                setActivatorNodeRef={setActivatorNodeRef}
                label={`Drag to reorder ${child.name} within ${groupName}`}
            />
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="min-w-0 flex-1 truncate">{child.name}</span>
            <button
                type="button"
                aria-label={`Options for ${child.name}`}
                onClick={(event) => onContextMenu({
                    id: child.id,
                    kind: 'item',
                    name: child.name,
                    defaultName: DEFAULT_NAVIGATION_NAMES[`item:${child.id}`] ?? child.name,
                }, event)}
                className={ITEM_OPTIONS}
            >
                &hellip;
            </button>
        </div>
    );
}

function SortableNavigationEntry({
    entry,
    expandedGroupIds,
    isReordering,
    onContextMenu,
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
        NAVIGATION_ROW,
        active
            ? 'bg-sidebar-accent text-sidebar-primary shadow-sm ring-1 ring-sidebar-border'
            : IDLE_ROW,
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
                <div className="space-y-1.5">
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
                        <button
                            type="button"
                            aria-label={`Options for ${entry.name}`}
                            onClick={(event) => onContextMenu({
                                id: entry.id,
                                kind: isNavigationGroup(entry) ? 'folder' : 'item',
                                name: entry.name,
                                defaultName: DEFAULT_NAVIGATION_NAMES[`${isNavigationGroup(entry) ? 'folder' : 'item'}:${entry.id}`] ?? entry.name,
                            }, event)}
                            className={ITEM_OPTIONS}
                        >
                            &hellip;
                        </button>
                    </div>
                    {isNavigationGroup(entry) ? (
                        <SortableContext
                            items={entry.children.map((child) => child.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <div className="ml-7 space-y-1 border-l border-sidebar-border pl-2">
                                {entry.children.map((child) => (
                                    <SortableNavigationChild
                                        key={child.id}
                                        child={child}
                                        groupName={entry.name}
                                        onContextMenu={onContextMenu}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    ) : null}
                </div>
            ) : isNavigationGroup(entry) ? (
                <NavigationGroupRow
                    active={active}
                    expanded={expandedGroupIds.has(entry.id)}
                    group={entry}
                    onContextMenu={onContextMenu}
                    onNavigate={onNavigate}
                    onToggle={() => onToggleGroup(entry.id)}
                    pathname={pathname}
                />
            ) : (
                <NavigationLeafLink
                    leaf={entry}
                    active={active}
                    onContextMenu={onContextMenu}
                    onNavigate={onNavigate}
                />
            )}
        </div>
    );
}

function SidebarSection({
    expandedGroupIds,
    isReordering,
    onContextMenu,
    onNavigate,
    onToggleGroup,
    pathname,
    section,
}: SidebarSectionProps) {
    const headingId = `${section.id}-heading`;

    return (
        <section aria-labelledby={headingId} className="space-y-2">
            <div
                className="px-1"
                onContextMenu={(event) => onContextMenu({
                    id: section.id,
                    kind: 'section',
                    name: section.label,
                    defaultName: DEFAULT_NAVIGATION_NAMES[`section:${section.id}`] ?? section.label,
                }, event)}
            >
                <h2
                    id={headingId}
                    className="text-[11px] font-semibold tracking-wide text-muted-foreground"
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
                            onContextMenu={onContextMenu}
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


type Props = Omit<SidebarSectionProps, 'section'> & { sections: SidebarSectionProps['section'][]; onDragEnd: (event: DragEndEvent, move: typeof arrayMove) => void };
export default function SidebarReorderNavigation({ sections, onDragEnd, ...props }: Props) {
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

return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => onDragEnd(event, arrayMove)}><div className="space-y-5 pr-1">{sections.map(section => <SidebarSection key={section.id} section={section} {...props}/>)}</div></DndContext>;
}
