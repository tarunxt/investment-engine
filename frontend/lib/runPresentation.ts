import type { SwingTradeMarket } from '@/lib/swingTrade';

type SheetsPresentationState =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'disabled';

type SheetsJobLike = {
  status?: string | null;
  export_status?: string | null;
  error_message?: string | null;
  export_error?: string | null;
};

type ExportRowProgress = {
  exportedRows: number;
  expectedRows: number;
};

export type SheetsPresentation = {
  state: SheetsPresentationState;
  label: string;
  exportedRows: number | null;
  expectedRows: number | null;
};

const INSUFFICIENT_RECOMMENDATIONS_RE = /expected\s+(\d+)\s*,\s*got\s+(\d+)/i;
const EXPORTED_ROWS_RE = /(\d+)\s*\/\s*(\d+)\s*exported/i;

const SWING_TRADE_MARKET_PATTERNS: Record<SwingTradeMarket, RegExp[]> = {
  india: [
    /\bzerodha\b/i,
    /\bindia(?:n)?\b[^.\n]{0,220}\b(?:portfolio|holdings|equity|equities|stocks|swing[-\s]?trade|rebalance)\b/i,
    /\b(?:portfolio|holdings|equity|equities|stocks|swing[-\s]?trade|rebalance)\b[^.\n]{0,220}\bindia(?:n)?\b/i,
    /\baggressive swing[-\s]?trad[^.\n]{0,180}\bindia(?:n)?\b/i,
  ],
  us: [
    /\bindmoney\s*us\b/i,
    /\b(?:us|u\.s\.|usa|united states)\b[^.\n]{0,220}\b(?:portfolio|holdings|equity|equities|stocks|swing[-\s]?trade|rebalance)\b/i,
    /\b(?:portfolio|holdings|equity|equities|stocks|swing[-\s]?trade|rebalance)\b[^.\n]{0,220}\b(?:us|u\.s\.|usa|united states)\b/i,
    /\baggressive swing[-\s]?trad[^.\n]{0,180}\b(?:us|u\.s\.|usa|united states)\b/i,
  ],
};

const PORTFOLIO_LABELS: Record<SwingTradeMarket, string> = {
  india: 'Zerodha',
  us: 'IndMoney',
};

const TECHNICAL_SCAN_MARKER_RE = /##\s*Technical Scan Input Bundle/i;
const REBALANCE_MARKET_MARKERS: Record<SwingTradeMarket, RegExp> = {
  india: /\[rebalance_flow:india\]/i,
  us: /\[rebalance_flow:us\]/i,
};

function isSheetsPresentationState(value: string): value is SheetsPresentationState {
  return (
    value === 'pending' ||
    value === 'queued' ||
    value === 'processing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'partial' ||
    value === 'disabled'
  );
}

function normalizeStatus(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseExportRowProgress(...candidates: Array<string | null | undefined>): ExportRowProgress | null {
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (!text) continue;

    const insufficientMatch = text.match(INSUFFICIENT_RECOMMENDATIONS_RE);
    if (insufficientMatch) {
      const expectedRows = Number(insufficientMatch[1]);
      const exportedRows = Number(insufficientMatch[2]);
      if (expectedRows > 0 && exportedRows >= 0) {
        return {
          exportedRows: Math.min(exportedRows, expectedRows),
          expectedRows,
        };
      }
    }

    const exportedMatch = text.match(EXPORTED_ROWS_RE);
    if (exportedMatch) {
      const exportedRows = Number(exportedMatch[1]);
      const expectedRows = Number(exportedMatch[2]);
      if (expectedRows > 0 && exportedRows >= 0) {
        return {
          exportedRows: Math.min(exportedRows, expectedRows),
          expectedRows,
        };
      }
    }
  }

  return null;
}

function getBaseSheetsState({
  autoExportEnabled,
  jobStatus,
  exportStatus,
}: {
  autoExportEnabled: boolean;
  jobStatus?: string | null;
  exportStatus?: string | null;
}): SheetsPresentationState {
  const normalizedExportStatus = normalizeStatus(exportStatus);
  if (isSheetsPresentationState(normalizedExportStatus)) {
    return normalizedExportStatus;
  }
  if (!autoExportEnabled) {
    return 'disabled';
  }

  const normalizedJobStatus = normalizeStatus(jobStatus);
  if (normalizedJobStatus === 'failed') {
    return 'failed';
  }
  if (normalizedJobStatus === 'completed') {
    return 'processing';
  }
  if (normalizedJobStatus === 'pending' || normalizedJobStatus === 'processing' || normalizedJobStatus === 'scheduled') {
    return 'pending';
  }

  return 'pending';
}

export function inferSwingTradeMarketFromPrompt(prompt?: string | null): SwingTradeMarket | null {
  const text = prompt?.trim();
  if (!text) return null;
  if (TECHNICAL_SCAN_MARKER_RE.test(text)) return null;
  if (Object.values(REBALANCE_MARKET_MARKERS).some((pattern) => pattern.test(text))) return null;

  if (SWING_TRADE_MARKET_PATTERNS.india.some((pattern) => pattern.test(text))) {
    return 'india';
  }
  if (SWING_TRADE_MARKET_PATTERNS.us.some((pattern) => pattern.test(text))) {
    return 'us';
  }

  return null;
}

export function isRunInSwingTradeMarket(
  prompt: string | null | undefined,
  market: SwingTradeMarket | null,
) {
  if (!market) return true;
  return inferSwingTradeMarketFromPrompt(prompt) === market;
}

export function getPortfolioLabelForMarket(market?: SwingTradeMarket | null) {
  if (!market) return null;
  return PORTFOLIO_LABELS[market] ?? null;
}

export function getRunScopeLabelFromPrompt(prompt?: string | null) {
  const text = prompt?.trim();
  if (!text) return null;

  const rebalanceMarket = (Object.keys(REBALANCE_MARKET_MARKERS) as SwingTradeMarket[]).find((market) =>
    REBALANCE_MARKET_MARKERS[market].test(text),
  );
  if (rebalanceMarket) {
    return `${getPortfolioLabelForMarket(rebalanceMarket)} Rebalance`;
  }

  const swingMarket = inferSwingTradeMarketFromPrompt(text);
  if (swingMarket) {
    return `${getPortfolioLabelForMarket(swingMarket)} Swing`;
  }

  return null;
}

export function formatRunLabel(runId: number, scopeLabel?: string | null) {
  return scopeLabel ? `#${runId} ${scopeLabel}` : `#${runId}`;
}

export function getRunLabelFromPrompt(runId: number, prompt?: string | null) {
  return formatRunLabel(runId, getRunScopeLabelFromPrompt(prompt));
}

export function getRunDetailPathFromPrompt(runId: number, prompt?: string | null) {
  const market = inferSwingTradeMarketFromPrompt(prompt);

  if (market === 'india') {
    return `/console/zerodha-swing-run/${runId}`;
  }

  if (market === 'us') {
    return `/console/indmoney-us-swing-run/${runId}`;
  }

  return `/console/runs/${runId}`;
}

export function getJobSheetsPresentation({
  autoExportEnabled,
  jobStatus,
  exportStatus,
  errorMessage,
  exportError,
}: {
  autoExportEnabled: boolean;
  jobStatus?: string | null;
  exportStatus?: string | null;
  errorMessage?: string | null;
  exportError?: string | null;
}): SheetsPresentation {
  const baseState = getBaseSheetsState({ autoExportEnabled, jobStatus, exportStatus });
  const rowProgress = parseExportRowProgress(errorMessage, exportError);

  if (rowProgress && rowProgress.exportedRows < rowProgress.expectedRows) {
    if (baseState === 'completed' || baseState === 'partial') {
      return {
        state: 'partial',
        label: `(${rowProgress.exportedRows}/${rowProgress.expectedRows}) Partially Exported`,
        exportedRows: rowProgress.exportedRows,
        expectedRows: rowProgress.expectedRows,
      };
    }
  }

  if (baseState === 'completed') {
    return {
      state: 'completed',
      label: 'Exported',
      exportedRows: rowProgress?.exportedRows ?? null,
      expectedRows: rowProgress?.expectedRows ?? null,
    };
  }

  if (baseState === 'partial') {
    return {
      state: 'partial',
      label: rowProgress
        ? `(${rowProgress.exportedRows}/${rowProgress.expectedRows}) Partially Exported`
        : 'Partially Exported',
      exportedRows: rowProgress?.exportedRows ?? null,
      expectedRows: rowProgress?.expectedRows ?? null,
    };
  }

  if (baseState === 'failed') {
    return {
      state: 'failed',
      label: 'Failed',
      exportedRows: rowProgress?.exportedRows ?? null,
      expectedRows: rowProgress?.expectedRows ?? null,
    };
  }

  if (baseState === 'disabled') {
    return {
      state: 'disabled',
      label: 'Disabled',
      exportedRows: null,
      expectedRows: null,
    };
  }

  return {
    state: baseState,
    label: titleCase(baseState),
    exportedRows: rowProgress?.exportedRows ?? null,
    expectedRows: rowProgress?.expectedRows ?? null,
  };
}

export function getRunSheetsPresentation({
  autoExportEnabled,
  runJobs,
  exportStatus,
}: {
  autoExportEnabled: boolean;
  runJobs: SheetsJobLike[];
  exportStatus?: string | null;
}): SheetsPresentation {
  const jobPresentations = runJobs
    .map((job) =>
      getJobSheetsPresentation({
        autoExportEnabled,
        jobStatus: job.status,
        exportStatus: job.export_status,
        errorMessage: job.error_message,
        exportError: job.export_error,
      }),
    )
    .filter((presentation) => presentation.state !== 'disabled');

  if (jobPresentations.length === 1) {
    return jobPresentations[0];
  }

  if (jobPresentations.length > 1) {
    const completedCount = jobPresentations.filter((job) => job.state === 'completed').length;
    const failedCount = jobPresentations.filter((job) => job.state === 'failed').length;
    const partialCount = jobPresentations.filter((job) => job.state === 'partial').length;

    if (completedCount === jobPresentations.length) {
      return { state: 'completed', label: 'Exported', exportedRows: null, expectedRows: null };
    }
    if (failedCount === jobPresentations.length) {
      return { state: 'failed', label: 'Failed', exportedRows: null, expectedRows: null };
    }
    if (partialCount > 0 || completedCount > 0) {
      return { state: 'partial', label: 'Partially Exported', exportedRows: null, expectedRows: null };
    }
  }

  const normalizedRunExportStatus = normalizeStatus(exportStatus);
  const fallbackState = isSheetsPresentationState(normalizedRunExportStatus)
    ? normalizedRunExportStatus
    : autoExportEnabled
      ? 'pending'
      : 'disabled';
  return {
    state: fallbackState,
    label: fallbackState === 'completed' ? 'Exported' : titleCase(fallbackState),
    exportedRows: null,
    expectedRows: null,
  };
}
