'use client';

import type { ComponentProps, ReactNode } from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SidebarDragBindings } from './SidebarNavigation';

function Item({ id, children }: ComponentProps<SidebarDragBindings['Item']>) {
    const sortable = useSortable({ id });
    return children({ ...sortable, style: { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition } });
}
function List({ items, children }: { items: string[]; children: ReactNode }) {
    return <SortableContext items={items} strategy={verticalListSortingStrategy}>{children}</SortableContext>;
}
const bindings: SidebarDragBindings = { Item, List };

export default function SidebarDragRuntime({ children, onDragEnd }: {
    children: (bindings: SidebarDragBindings) => ReactNode;
    onDragEnd: (event: DragEndEvent) => void;
}) {
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>{children(bindings)}</DndContext>;
}
