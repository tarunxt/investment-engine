export type ScanMode = "30-days" | "end-of-month";

export type BullpenQuestion = {
  id: string;
  question: string;
  closeTime: string | null;
  category: string;
  yesOdds: number | null;
  noOdds: number | null;
  volume: string | null;
  liquidity: string | null;
  sourceUrl: string;
  slug: string | null;
  marketUrl: string | null;
  outcomeLabels: string[];
  outcomeCount: number | null;
  isBinaryYesNo: boolean;
  daysUntilClose: number | null;
};

export type BullpenScanFilters = {
  maxClosingDays: number;
  targetDate: string;
  excludeSports: boolean;
  excludeWeather: boolean;
  excludeMarketPredictions: boolean;
  onlyBinaryYesNo: boolean;
  minYesOdds: number;
  minNoOdds: number;
};

export type ScanResult = {
  mode: ScanMode;
  sourceUrl: string;
  sourceLabel: string;
  scannedAt: string;
  filters: BullpenScanFilters;
  totalCandidates: number;
  questions: BullpenQuestion[];
  error?: string;
  warning?: string;
  details?: string;
};

export const END_OF_MONTH_DATE = "2026-06-30";

export const BULLPEN_SOURCE_URLS: Record<ScanMode, string> = {
  "30-days": "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
  "end-of-month":
    "https://app.bullpen.fi/predictions/trending?primaryMode=calendar&ref=intrepid-crane-3",
};

export const DEFAULT_BULLPEN_SCAN_FILTERS: Record<
  ScanMode,
  BullpenScanFilters
> = {
  "30-days": {
    maxClosingDays: 30,
    targetDate: END_OF_MONTH_DATE,
    excludeSports: true,
    excludeWeather: true,
    excludeMarketPredictions: true,
    onlyBinaryYesNo: true,
    minYesOdds: 5,
    minNoOdds: 5,
  },
  "end-of-month": {
    maxClosingDays: 30,
    targetDate: END_OF_MONTH_DATE,
    excludeSports: true,
    excludeWeather: true,
    excludeMarketPredictions: true,
    onlyBinaryYesNo: true,
    minYesOdds: 5,
    minNoOdds: 5,
  },
};

type SearchParamReader = {
  get(name: string): string | null;
};

function parseBooleanSearchParam(value: string | null, fallback: boolean) {
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function parseNumberSearchParam(value: string | null, fallback: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateSearchParam(value: string | null, fallback: string) {
  if (!value) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export function createBullpenScanFilters(
  mode: ScanMode,
): BullpenScanFilters {
  return { ...DEFAULT_BULLPEN_SCAN_FILTERS[mode] };
}

export function normalizeBullpenScanFilters(
  mode: ScanMode,
  searchParams: SearchParamReader,
): BullpenScanFilters {
  const defaults = DEFAULT_BULLPEN_SCAN_FILTERS[mode];
  return {
    maxClosingDays: Math.max(
      1,
      parseNumberSearchParam(searchParams.get("maxClosingDays"), defaults.maxClosingDays),
    ),
    targetDate: parseDateSearchParam(
      searchParams.get("targetDate"),
      defaults.targetDate,
    ),
    excludeSports: parseBooleanSearchParam(
      searchParams.get("excludeSports"),
      defaults.excludeSports,
    ),
    excludeWeather: parseBooleanSearchParam(
      searchParams.get("excludeWeather"),
      defaults.excludeWeather,
    ),
    excludeMarketPredictions: parseBooleanSearchParam(
      searchParams.get("excludeMarketPredictions"),
      defaults.excludeMarketPredictions,
    ),
    onlyBinaryYesNo: parseBooleanSearchParam(
      searchParams.get("onlyBinaryYesNo"),
      defaults.onlyBinaryYesNo,
    ),
    minYesOdds: Math.max(
      0,
      parseNumberSearchParam(searchParams.get("minYesOdds"), defaults.minYesOdds),
    ),
    minNoOdds: Math.max(
      0,
      parseNumberSearchParam(searchParams.get("minNoOdds"), defaults.minNoOdds),
    ),
  };
}

export function buildBullpenScanQueryParams(
  mode: ScanMode,
  filters: BullpenScanFilters,
) {
  const params = new URLSearchParams();
  params.set("mode", mode);
  params.set("maxClosingDays", String(filters.maxClosingDays));
  params.set("targetDate", filters.targetDate);
  params.set("excludeSports", String(filters.excludeSports));
  params.set("excludeWeather", String(filters.excludeWeather));
  params.set(
    "excludeMarketPredictions",
    String(filters.excludeMarketPredictions),
  );
  params.set("onlyBinaryYesNo", String(filters.onlyBinaryYesNo));
  params.set("minYesOdds", String(filters.minYesOdds));
  params.set("minNoOdds", String(filters.minNoOdds));
  return params;
}
