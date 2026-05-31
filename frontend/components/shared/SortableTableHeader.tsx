import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import type { SortDirection } from '@/lib/tableSorting';

export function SortableTableHeader({
  label,
  activeDirection,
  onToggle,
  className,
}: {
  label: string;
  activeDirection: SortDirection | null;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <th
      className={className}
      aria-sort={
        activeDirection === 'asc' ? 'ascending' : activeDirection === 'desc' ? 'descending' : 'none'
      }
    >
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-left transition-colors hover:text-gray-600"
      >
        <span>{label}</span>
        {activeDirection === 'asc' ? (
          <ArrowUp className="size-3.5 shrink-0" />
        ) : activeDirection === 'desc' ? (
          <ArrowDown className="size-3.5 shrink-0" />
        ) : (
          <ArrowUpDown className="size-3.5 shrink-0 opacity-70" />
        )}
      </button>
    </th>
  );
}
