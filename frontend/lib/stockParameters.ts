export type StockParameter = {
  id: string;
  parameter: string;
  description: string;
  validationRule: string;
};

export const STOCK_PARAMETERS_STORAGE_KEY = 'credx-stock-parameters-v1';

export const DEFAULT_STOCK_PARAMETERS: StockParameter[] = [
  { id: 'exchange-symbol', parameter: 'Exchange Symbol', description: 'Listing exchange for the security.', validationRule: 'NASDAQ/NYSE for US & NSE/BSE for Ind' },
  { id: 'stock-symbol', parameter: 'Stock Symbol', description: 'Ticker symbol used by the exchange.', validationRule: 'Less than 5 chars' },
  { id: 'current-units', parameter: 'Current Units', description: 'Current number of units held.', validationRule: 'number' },
  { id: 'action', parameter: 'Action (Buy/Add/Sell All/Trim/Hold/Buy New)', description: 'Portfolio action recommended by the prompt output.', validationRule: 'Buy/Add/Sell All/Trim/Hold/Buy New only' },
  { id: 'units-change', parameter: 'Units Change', description: 'Change in units versus current holding.', validationRule: 'number' },
  { id: 'final-units', parameter: 'Final Units', description: 'Final number of units after action.', validationRule: 'number' },
  { id: 'technical-setup', parameter: 'Technical Setup', description: 'Brief technical setup or pattern summary.', validationRule: 'text' },
  { id: 'entry-range', parameter: 'Entry Range', description: 'Suggested price entry range.', validationRule: 'combination of numbers' },
  { id: 'stop-loss', parameter: 'Stop Loss', description: 'Invalidation or stop-loss price.', validationRule: 'number' },
  { id: 'target', parameter: 'Target', description: 'Target price or objective.', validationRule: 'number' },
  { id: 'analyst-source', parameter: 'Analyst/Source', description: 'Source, analyst, model, or research attribution.', validationRule: 'text' },
  { id: 'units-to-buy', parameter: 'Units to Buy', description: 'Number of units to buy.', validationRule: 'number' },
  { id: 'price-per-unit', parameter: 'Price Per Unit', description: 'Price for each unit.', validationRule: 'number' },
  { id: 'total-buy-amount', parameter: 'Total Buy Amount', description: 'Total amount allocated to buy.', validationRule: 'number' },
  { id: 'upside-horizon', parameter: 'Upside Horizon (% return)', description: 'Expected return over the stated horizon.', validationRule: 'number' },
  { id: 'weeks', parameter: 'Weeks', description: 'Expected time horizon in weeks.', validationRule: 'number' },
  { id: 'confidence-score', parameter: 'Confidence Score (0-100)', description: 'Confidence score bounded from 0 to 100.', validationRule: 'number between 0 and 100' },
  { id: 'rationale-cruxx', parameter: 'Rationale Cruxx', description: 'Concise rationale summary.', validationRule: 'text' },
  { id: 'score-rationale-cruxx', parameter: 'Score Rationale Cruxx', description: 'Numeric score for the rationale crux.', validationRule: 'number' },
  { id: 'rationale-technical-short', parameter: 'Rationale - Technical Setup (Short Term 1–3 Months)', description: 'Short-term technical rationale.', validationRule: 'text' },
  { id: 'score-rationale-technical-short', parameter: 'Score Rationale - Technical Setup (Short Term 1–3 Months)', description: 'Numeric score for short-term technical setup.', validationRule: 'number' },
  { id: 'rationale-technical-medium', parameter: 'Rationale - Technical Setup (Medium Term)', description: 'Medium-term technical rationale.', validationRule: 'text' },
  { id: 'score-rationale-technical-medium', parameter: 'Score Rationale - Technical Setup (Medium Term)', description: 'Numeric score for medium-term technical setup.', validationRule: 'number' },
  { id: 'rationale-technical-long', parameter: 'Rationale - Technical Setup (Long Term)', description: 'Long-term technical rationale.', validationRule: 'text' },
  { id: 'score-rationale-technical-long', parameter: 'Score Rationale - Technical Setup (Long Term)', description: 'Numeric score for long-term technical setup.', validationRule: 'number' },
  { id: 'rationale-fundamentals-short', parameter: 'Rationale - Fundamentals Short Term', description: 'Short-term fundamental rationale.', validationRule: 'text' },
  { id: 'score-rationale-fundamentals-short', parameter: 'Score Rationale - Fundamentals Short Term', description: 'Numeric score for short-term fundamentals.', validationRule: 'number' },
  { id: 'rationale-fundamentals-medium-long', parameter: 'Rationale - Fundamentals Medium/Long Term', description: 'Medium/long-term fundamental rationale.', validationRule: 'text' },
  { id: 'score-rationale-fundamentals-medium-long', parameter: 'Score Rationale - Fundamentals Medium/Long Term', description: 'Numeric score for medium/long-term fundamentals.', validationRule: 'number' },
];

export function normalizeParameterName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createStockParameter(parameter: string, validationRule = 'text', description = 'User-added stock output column header.'): StockParameter {
  const clean = parameter.trim().replace(/\s+/g, ' ');
  return {
    id: `${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'parameter'}-${Date.now()}`,
    parameter: clean,
    description,
    validationRule: validationRule.trim() || 'text',
  };
}

export function loadStockParametersFromStorage(): StockParameter[] {
  if (typeof window === 'undefined') return DEFAULT_STOCK_PARAMETERS;
  try {
    const raw = window.localStorage.getItem(STOCK_PARAMETERS_STORAGE_KEY);
    if (!raw) return DEFAULT_STOCK_PARAMETERS;
    const parsed = JSON.parse(raw) as StockParameter[];
    if (!Array.isArray(parsed)) return DEFAULT_STOCK_PARAMETERS;
    const merged = [...DEFAULT_STOCK_PARAMETERS];
    parsed.forEach((item) => {
      if (!item?.parameter) return;
      const existingIndex = merged.findIndex((param) => normalizeParameterName(param.parameter) === normalizeParameterName(item.parameter));
      if (existingIndex >= 0) merged[existingIndex] = { ...merged[existingIndex], ...item };
      else merged.push(item);
    });
    return merged;
  } catch {
    return DEFAULT_STOCK_PARAMETERS;
  }
}

export function saveStockParametersToStorage(parameters: StockParameter[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STOCK_PARAMETERS_STORAGE_KEY, JSON.stringify(parameters));
  window.dispatchEvent(new CustomEvent('stock-parameters-updated', { detail: parameters }));
}

export function buildMasterValidationChecklist(parameters: StockParameter[]) {
  return [
    'Master Validation Rules: validate every output table cell against the Stock Parameters repository in addition to this stage-specific checklist.',
    'Only output column headers that exist in the Stock Parameters repository. If a needed header is missing, add it to Rules > Stock Parameters before saving this prompt.',
    'Flag and correct any table value that violates its column validation rule before final output.',
    ...parameters.map((param) => `- ${param.parameter}: ${param.validationRule}`),
  ].join('\n');
}

export function validateStockParameterValue(parameter: StockParameter, value: string) {
  const trimmed = value.trim();
  const rule = parameter.validationRule.toLowerCase();
  if (!trimmed || ['-', '—', 'n/a', 'na'].includes(trimmed.toLowerCase())) return true;
  if (parameter.parameter === 'Exchange Symbol') return /^(NASDAQ|NYSE|NSE|BSE)$/i.test(trimmed);
  if (parameter.parameter === 'Stock Symbol') return /^[A-Z.\-]{1,4}$/i.test(trimmed);
  if (parameter.parameter.startsWith('Action')) return /^(Buy|Add|Sell All|Trim|Hold|Buy New)$/i.test(trimmed);
  if (rule.includes('0') && rule.includes('100')) {
    const valueNumber = Number(trimmed.replace(/%$/, ''));
    return Number.isFinite(valueNumber) && valueNumber >= 0 && valueNumber <= 100;
  }
  if (rule.includes('combination of numbers')) return /\d/.test(trimmed) && /^[\d\s.,%+\-–—/()₹$toTO]+$/.test(trimmed);
  if (rule.includes('number')) {
    const normalized = trimmed.replace(/[$₹,%\s]/g, '');
    return normalized !== '' && Number.isFinite(Number(normalized));
  }
  return true;
}
