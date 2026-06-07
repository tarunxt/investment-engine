export type StandardActionCategory = 'Sell All' | 'Trim' | 'Hold' | 'Buy New' | 'Add more';

export const STANDARD_ACTION_ORDER: StandardActionCategory[] = [
  'Sell All',
  'Trim',
  'Add more',
  'Buy New',
  'Hold',
];

export const STANDARD_ACTION_BADGE_CLASS: Record<StandardActionCategory, string> = {
  'Sell All': 'border-red-200 bg-red-50 text-red-700',
  Trim: 'border-red-100 bg-red-50 text-red-600',
  Hold: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  'Buy New': 'border-emerald-100 bg-emerald-50 text-emerald-700',
  'Add more': 'border-emerald-200 bg-emerald-100 text-emerald-800',
};

export const STANDARD_ACTION_TEXT_CLASS: Record<StandardActionCategory, string> = {
  'Sell All': 'text-red-700',
  Trim: 'text-red-600',
  Hold: 'text-yellow-800',
  'Buy New': 'text-emerald-700',
  'Add more': 'text-emerald-800',
};

export const STANDARD_ACTION_ROW_CLASS: Record<StandardActionCategory, string> = {
  'Sell All': 'bg-red-50/90',
  Trim: 'bg-red-50/70',
  Hold: 'bg-yellow-50/80',
  'Buy New': 'bg-emerald-50/70',
  'Add more': 'bg-emerald-100/70',
};

export const STANDARD_ACTION_NAME_CELL_CLASS: Record<StandardActionCategory, string> = {
  'Sell All': 'text-red-950',
  Trim: 'text-red-900',
  Hold: 'text-yellow-950',
  'Buy New': 'text-emerald-900',
  'Add more': 'text-emerald-950',
};

export function getStandardActionBadgeClass(action: StandardActionCategory) {
  return STANDARD_ACTION_BADGE_CLASS[action];
}

export function getStandardActionTextClass(action: StandardActionCategory) {
  return STANDARD_ACTION_TEXT_CLASS[action];
}

export function getStandardActionRowClass(action: StandardActionCategory) {
  return STANDARD_ACTION_ROW_CLASS[action];
}
