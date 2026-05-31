export type SortDirection = 'asc' | 'desc';

export type SortState<TColumn extends string> = {
  column: TColumn;
  direction: SortDirection;
} | null;

export type SortAccessor<TItem> = {
  type: 'number' | 'text';
  getValue: (item: TItem) => number | string | null | undefined;
};

export function compareSortableValues(
  left: number | string | null | undefined,
  right: number | string | null | undefined,
  type: 'number' | 'text',
  direction: SortDirection,
) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;

  const comparison =
    type === 'number'
      ? Number(left) - Number(right)
      : String(left).localeCompare(String(right), undefined, {
          numeric: true,
          sensitivity: 'base',
        });

  return direction === 'asc' ? comparison : -comparison;
}

export function toggleSortState<TColumn extends string>(
  currentSort: SortState<TColumn>,
  column: TColumn,
): SortState<TColumn> {
  if (currentSort?.column !== column) {
    return {
      column,
      direction: 'asc',
    };
  }

  if (currentSort.direction === 'asc') {
    return {
      column,
      direction: 'desc',
    };
  }

  return null;
}

export function sortItems<TItem, TColumn extends string>(
  items: TItem[],
  sortState: SortState<TColumn>,
  accessors: Record<TColumn, SortAccessor<TItem>>,
  getTieBreaker?: (item: TItem) => number | string | null | undefined,
) {
  if (!sortState) {
    return items;
  }

  const accessor = accessors[sortState.column];

  return [...items].sort((left, right) => {
    const primaryComparison = compareSortableValues(
      accessor.getValue(left),
      accessor.getValue(right),
      accessor.type,
      sortState.direction,
    );

    if (primaryComparison !== 0 || !getTieBreaker) {
      return primaryComparison;
    }

    return compareSortableValues(getTieBreaker(left), getTieBreaker(right), 'text', 'asc');
  });
}
