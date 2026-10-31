type CostDriver = {
  rank: number;
  driver: string;
  source: string;
  monthToDateCost: number;
  projectedMonthEndCost: number;
  usageQuantity: number;
  unit: string;
  confidence: string;
  severity: string;
  whyItCostsMoney: string;
  suggestedAction: string;
  estimatedMonthlySavings: number;
  estimatedMonthlySavingsDisplay?: string | null;
  linkToAWSConsole?: string | null;
};
type Traffic = {
  path: string;
  contentType: string;
  extension: string;
  requests: number;
  totalBytes: number;
  totalGB: number;
  estimatedTransferCost: number;
  cacheHitRate: number;
  topUserAgent: string;
  classification: string;
  recommendation: string;
};
type EvidenceItem = {
  label: string;
  value: string | number;
  unit?: string | null;
};
export type Recommendation = {
  id?: string | null;
  driverKey: string;
  severity: string;
  title: string;
  explanation?: string;
  whyThisMatters?: string | null;
  suggestedAction?: string;
  recommendedActions?: string[];
  estimatedMonthlySavingsUsd?: number | null;
  confidence: string;
  source: string;
  evidence?: EvidenceItem[];
  lastCheckedAt?: string | null;
  relatedAwsConsoleUrl?: string | null;
};
export type TransferBreakdown = {
  classification: string;
  totalBytes: number;
  totalGB: number;
  requests: number;
  topPaths?: string[];
};
export type MetricRow = Record<
  string,
  string | number | boolean | TransferBreakdown[] | null | undefined
>;
export type Diagnostic = { service: string; status: string; message: string };
export type Dashboard = {
  summary: Record<string, unknown>;
  dailyCostTrend: MetricRow[];
  dataTransferTrend: MetricRow[];
  topServices: MetricRow[];
  topUsageTypes: MetricRow[];
  costDrivers: CostDriver[];
  traffic: Traffic[];
  recommendations: Recommendation[];
  inventory: Record<string, unknown>;
  debug: Record<string, unknown>;
  diagnostics?: Diagnostic[];
};
