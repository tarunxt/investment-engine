export type CostRecommendation = {
  id?: string | null;
  driverKey?: string;
  severity?: string;
  title?: string;
  explanation?: string;
  whyThisMatters?: string | null;
  suggestedAction?: string;
  recommendedActions?: string[];
  estimatedMonthlySavingsUsd?: number | null;
  confidence?: string;
  source?: string;
};

export type CostDashboard = {
  summary: Record<string, unknown>;
  topServices?: Array<Record<string, unknown>>;
  topUsageTypes?: Array<Record<string, unknown>>;
  costDrivers?: Array<Record<string, unknown>>;
  traffic?: Array<Record<string, unknown>>;
  recommendations?: CostRecommendation[];
  diagnostics?: Array<{
    service?: string;
    status?: string;
    message?: string;
  }>;
};

export type OptimizationPriority = "high" | "medium" | "low";
export type OptimizationEffort = "low" | "medium" | "high";

export type OptimizationAction = {
  id: string;
  title: string;
  category: string;
  priority: OptimizationPriority;
  confidence: string;
  effort: OptimizationEffort;
  rationale: string;
  steps: string[];
  estimatedMonthlySavingsUsd: number | null;
  source: string;
  state: "ready" | "measure-first";
};

export type OptimizationReview = {
  actualCostUsd: number;
  projectedCostUsd: number;
  comparisonCostUsd: number;
  priorMonthCostUsd: number;
  changeUsd: number;
  changePercent: number | null;
  computeCostUsd: number;
  computeSharePercent: number;
  taxCostUsd: number;
  preTaxCostUsd: number;
  ec2OtherCostUsd: number;
  lightsailCostUsd: number;
  otherPreTaxCostUsd: number;
  hasPriorMonthData: boolean;
  knownMonthlySavingsUsd: number;
  dataTransferUsedGb: number;
  observedOverageGb: number;
  observedOverageCostUsd: number;
  publicIpv4Count: number;
  publicIpv4BilledCostUsd: number;
  routeAttributionAvailable: boolean;
  coverageReady: number;
  coverageTotal: number;
  diagnosticWarnings: string[];
  actions: OptimizationAction[];
};

const asNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalized = (value: unknown): string => asString(value).toLowerCase();

const summaryNumber = (dashboard: CostDashboard, key: string): number =>
  asNumber(dashboard.summary?.[key]);

const rowName = (row: Record<string, unknown>): string =>
  asString(row.name || row.service || row.driver || row.description);

const rowCost = (row: Record<string, unknown>): number =>
  asNumber(
    row.cost ||
      row.monthToDateCost ||
      row.monthToDateAwsCost ||
      row.projectedMonthEndCost,
  );

const findServiceCost = (
  dashboard: CostDashboard,
  matcher: (serviceName: string) => boolean,
): number =>
  (dashboard.topServices || []).reduce((total, row) => {
    const name = rowName(row).toLowerCase();
    return matcher(name) ? total + rowCost(row) : total;
  }, 0);

const isTaxRecommendation = (recommendation: CostRecommendation): boolean => {
  const fields = [
    recommendation.driverKey,
    recommendation.title,
    recommendation.source,
  ]
    .map(normalized)
    .join(" ");
  return /(^|\s|[-_/])tax($|\s|[-_/])/.test(fields);
};

const normalizePriority = (severity?: string): OptimizationPriority => {
  const value = normalized(severity);
  if (value === "critical" || value === "high") return "high";
  if (value === "low" || value === "info") return "low";
  return "medium";
};

const classifyCategory = (recommendation: CostRecommendation): string => {
  const value = `${recommendation.driverKey || ""} ${recommendation.title || ""}`.toLowerCase();
  if (value.includes("transfer") || value.includes("bandwidth")) return "Data transfer";
  if (value.includes("ipv4") || value.includes("network")) return "Networking";
  if (value.includes("lightsail")) return "Legacy resources";
  if (value.includes("ebs") || value.includes("storage")) return "Storage";
  if (value.includes("ec2") || value.includes("compute")) return "Compute";
  return "AWS resources";
};

const classifyEffort = (recommendation: CostRecommendation): OptimizationEffort => {
  const value = `${recommendation.driverKey || ""} ${recommendation.title || ""}`.toLowerCase();
  if (value.includes("delete") || value.includes("unattached") || value.includes("ipv4")) {
    return "low";
  }
  if (value.includes("migration") || value.includes("architecture")) return "high";
  return "medium";
};

const recommendationAction = (
  recommendation: CostRecommendation,
  index: number,
): OptimizationAction | null => {
  if (isTaxRecommendation(recommendation)) return null;
  const title = recommendation.title?.trim();
  if (!title) return null;
  const steps = (recommendation.recommendedActions || []).filter(Boolean);
  if (!steps.length && recommendation.suggestedAction) {
    steps.push(recommendation.suggestedAction);
  }
  const savings = recommendation.estimatedMonthlySavingsUsd;
  return {
    id:
      recommendation.id ||
      recommendation.driverKey ||
      `recommendation-${index}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title,
    category: classifyCategory(recommendation),
    priority: normalizePriority(recommendation.severity),
    confidence: recommendation.confidence || "estimated",
    effort: classifyEffort(recommendation),
    rationale:
      recommendation.whyThisMatters ||
      recommendation.explanation ||
      "AWS billing or inventory data indicates an optimisation opportunity.",
    steps: steps.length ? steps : ["Review the supporting evidence before making a production change."],
    estimatedMonthlySavingsUsd:
      savings == null || !Number.isFinite(Number(savings)) ? null : Number(savings),
    source: recommendation.source || "cost-driver engine",
    state: savings == null ? "measure-first" : "ready",
  };
};

const containsAction = (actions: OptimizationAction[], terms: string[]): boolean =>
  actions.some((action) => {
    const haystack = `${action.id} ${action.title} ${action.category}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });

const addUnique = (actions: OptimizationAction[], action: OptimizationAction): void => {
  const key = `${action.id} ${action.title}`.toLowerCase();
  if (
    actions.some(
      (candidate) =>
        `${candidate.id} ${candidate.title}`.toLowerCase() === key ||
        candidate.title.toLowerCase() === action.title.toLowerCase(),
    )
  ) {
    return;
  }
  actions.push(action);
};

const monthlyCost = (dashboard?: CostDashboard | null): number => {
  if (!dashboard) return 0;
  const projected = summaryNumber(dashboard, "projectedMonthEndCost");
  const actual = summaryNumber(dashboard, "monthToDateAwsCost");
  return projected > 0 ? projected : actual;
};

export const previousMonthValue = (month: string): string => {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

export const buildOptimizationReview = (
  selected: CostDashboard,
  previous?: CostDashboard | null,
): OptimizationReview => {
  const actualCostUsd = summaryNumber(selected, "monthToDateAwsCost");
  const projectedCostUsd = summaryNumber(selected, "projectedMonthEndCost");
  const comparisonCostUsd = monthlyCost(selected);
  const priorMonthCostUsd = monthlyCost(previous);
  const changeUsd = comparisonCostUsd - priorMonthCostUsd;
  const changePercent =
    priorMonthCostUsd > 0 ? (changeUsd / priorMonthCostUsd) * 100 : null;

  const computeCostUsd = findServiceCost(
    selected,
    (name) =>
      name.includes("elastic compute cloud - compute") ||
      (name.includes("ec2") && name.includes("compute")),
  );
  const taxCostUsd = findServiceCost(selected, (name) => name === "tax" || name.endsWith(" tax"));
  const preTaxCostUsd = Math.max(actualCostUsd - taxCostUsd, 0);
  const ec2OtherCostUsd = findServiceCost(
    selected,
    (name) => name === "ec2 - other" || name.includes("ec2 other"),
  );
  const lightsailCostUsd = findServiceCost(selected, (name) => name.includes("lightsail"));
  const otherPreTaxCostUsd = Math.max(
    preTaxCostUsd - computeCostUsd - ec2OtherCostUsd - lightsailCostUsd,
    0,
  );
  const computeSharePercent =
    preTaxCostUsd > 0 ? (computeCostUsd / preTaxCostUsd) * 100 : 0;
  const hasPriorMonthData = Boolean(
    previous &&
      (summaryNumber(previous, "monthToDateAwsCost") > 0 ||
        Boolean(previous.topServices?.length)),
  );

  const actions: OptimizationAction[] = [];
  (selected.recommendations || []).forEach((recommendation, index) => {
    const action = recommendationAction(recommendation, index);
    if (action) addUnique(actions, action);
  });

  const runningInstances = summaryNumber(selected, "ec2RunningInstances");
  if (computeCostUsd > 0 && !containsAction(actions, ["right-size", "rightsize"])) {
    addUnique(actions, {
      id: "ec2-rightsizing-baseline",
      title: `Right-size the ${runningInstances || 1} running EC2 workload before buying commitments`,
      category: "Compute",
      priority: computeSharePercent >= 50 ? "high" : "medium",
      confidence: "measure first",
      effort: "medium",
      rationale: `EC2 compute is $${computeCostUsd.toFixed(2)} for the selected month, about ${computeSharePercent.toFixed(0)}% of pre-tax AWS service cost. It is the largest controllable cost, but a safe saving estimate requires CPU, memory, network and disk utilisation data.`,
      steps: [
        "Capture 14-day and 30-day P50/P95 CPU, memory, network and disk utilisation for the production instance.",
        "Test the next smaller instance size or a Graviton-compatible type in staging when P95 CPU and memory are both comfortably below the current capacity.",
        "Schedule only confirmed non-production runtimes; do not stop the single production instance merely to reduce cost.",
        "Compare Compute Savings Plans only after the right-sized baseline has remained stable for at least 30 days.",
      ],
      estimatedMonthlySavingsUsd: null,
      source: "AWS Cost Explorer + EC2 inventory",
      state: "measure-first",
    });
  }

  if (ec2OtherCostUsd > 0 && !containsAction(actions, ["ebs", "snapshot"])) {
    addUnique(actions, {
      id: "ec2-other-storage-review",
      title: "Separate active EBS storage from snapshots before deleting anything",
      category: "Storage",
      priority: "medium",
      confidence: "billed cost confirmed",
      effort: "low",
      rationale: `EC2 Other is ${ec2OtherCostUsd.toFixed(2)} USD for the selected month. This bucket can include active EBS volumes, snapshots and small transfer charges; only an ownerless or excess item is a saving.`,
      steps: [
        "Open the EC2 usage-type breakdown and separate gp3 volume, EBS snapshot and transfer charges.",
        "For every snapshot, record its source volume, age, owner, retention requirement and last restore test.",
        "Delete only an obsolete snapshot or unattached volume after an owner-approved recovery check.",
        "Right-size active gp3 capacity or provisioned performance only when utilisation proves it is excess.",
      ],
      estimatedMonthlySavingsUsd: null,
      source: "AWS Cost Explorer usage types + EC2 inventory",
      state: "measure-first",
    });
  }

  const publicIpv4Count = summaryNumber(selected, "activePublicIpv4Count");
  const publicIpv4BilledCostUsd = summaryNumber(selected, "publicIpv4BilledCostUsd");
  if (publicIpv4Count > 0 && !containsAction(actions, ["ipv4"])) {
    addUnique(actions, {
      id: "public-ipv4-review",
      title: "Verify the public IPv4 bill and production dependency",
      category: "Networking",
      priority: "medium",
      confidence: publicIpv4BilledCostUsd > 0 ? "billing matched" : "inventory only",
      effort: "low",
      rationale: `${publicIpv4Count} public IPv4 address exists in inventory, while ${publicIpv4BilledCostUsd.toFixed(2)} USD is currently matched to a Public IPv4 usage type. The list-price exposure is not a confirmed saving until the billed usage and production dependency are verified.`,
      steps: [
        "Map the address to its ENI and production dependency before changing it.",
        "Remove it only when the origin can use an existing private or already-paid ingress path.",
        "Do not add an ALB or NAT Gateway solely to avoid this charge; either service can cost more than the IPv4 saving.",
      ],
      estimatedMonthlySavingsUsd: null,
      source: "EC2 inventory + Cost Explorer usage types",
      state: "measure-first",
    });
  }

  const selectedOverageGb = summaryNumber(selected, "estimatedOverageGb");
  const selectedOverageUsd = summaryNumber(selected, "projectedOverageUsd");
  const previousOverageGb = previous ? summaryNumber(previous, "estimatedOverageGb") : 0;
  const previousOverageUsd = previous ? summaryNumber(previous, "projectedOverageUsd") : 0;
  const observedOverageGb = Math.max(selectedOverageGb, previousOverageGb);
  const observedOverageCostUsd = Math.max(selectedOverageUsd, previousOverageUsd);
  if (observedOverageGb > 0 && !containsAction(actions, ["transfer", "egress", "bandwidth"])) {
    addUnique(actions, {
      id: "internet-egress-control",
      title:
        selectedOverageGb > 0
          ? "Reduce projected internet-transfer overage"
          : "Prevent a repeat of the prior-month transfer overage",
      category: "Data transfer",
      priority: "high",
      confidence: selectedOverageGb > 0 ? "confirmed" : "historical evidence",
      effort: "medium",
      rationale:
        selectedOverageGb > 0
          ? `${selectedOverageGb.toFixed(2)} GB is projected above the 100 GB allowance, representing up to $${selectedOverageUsd.toFixed(2)} of current-month overage at the observed run rate.`
          : `${previousOverageGb.toFixed(2)} GB was above the 100 GB allowance in the prior month. Its $${previousOverageUsd.toFixed(2)} cost is historical avoided-cost context, not a saving in the selected month.`,
      steps: [
        "Identify the largest paths, response types and user agents before changing caching behaviour.",
        "Compress JSON, HTML, JavaScript and CSS responses and set long immutable cache headers for versioned assets.",
        "Move large static or media responses behind the existing CDN/object-storage path where this reduces origin egress.",
        "Rate-limit abusive bots and repeated downloads after validating that legitimate API and trading traffic is unaffected.",
      ],
      estimatedMonthlySavingsUsd: selectedOverageUsd > 0 ? selectedOverageUsd : null,
      source: "AWS Cost Explorer transfer usage",
      state: selectedOverageUsd > 0 ? "ready" : "measure-first",
    });
  }

  const routeAttributionAvailable = Boolean(selected.traffic?.length);
  if (!routeAttributionAvailable) {
    addUnique(actions, {
      id: "route-attribution-coverage",
      title: "Restore route and asset attribution before the next optimisation review",
      category: "Measurement",
      priority: observedOverageGb > 0 ? "high" : "medium",
      confidence: "data gap",
      effort: "medium",
      rationale: "AWS totals are available, but no application route, asset, content-type or bot attribution is being returned. Without that evidence, transfer recommendations cannot be safely tailored to the actual source of traffic.",
      steps: [
        "Emit request path, response bytes, content type, cache status and user agent from the production access-log pipeline.",
        "Aggregate route data daily and retain enough history to compare the current month with the previous month.",
        "Show the latest successful attribution timestamp and surface permission or ingestion failures as an alert.",
      ],
      estimatedMonthlySavingsUsd: null,
      source: "application traffic attribution",
      state: "measure-first",
    });
  }

  addUnique(actions, {
    id: "routine-finops-cadence",
    title: "Run a repeatable weekly and monthly cost review",
    category: "Governance",
    priority: "medium",
    confidence: "recommended control",
    effort: "low",
    rationale: "The current dashboard is useful for point-in-time review. Assigning an owner, status and review cadence makes savings measurable and prevents old resources or transfer spikes from recurring.",
    steps: [
      "Weekly: review daily cost anomalies, transfer usage, public IPv4, stopped instances and unattached storage.",
      "Monthly: record each action as accepted, deferred or completed with an owner, due date and realised saving.",
      "Quarterly: review instance architecture and commitment coverage only after rightsizing and demand stability are confirmed.",
      "Require Environment, Service, Owner and CostCentre tags for every billable production resource.",
    ],
    estimatedMonthlySavingsUsd: null,
    source: "Cred-X FinOps control",
    state: "ready",
  });

  const priorityWeight: Record<OptimizationPriority, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  actions.sort((left, right) => {
    const priorityDifference = priorityWeight[right.priority] - priorityWeight[left.priority];
    if (priorityDifference) return priorityDifference;
    return (
      (right.estimatedMonthlySavingsUsd || 0) -
      (left.estimatedMonthlySavingsUsd || 0)
    );
  });

  const knownMonthlySavingsUsd = actions.reduce(
    (total, action) =>
      total +
      (action.state === "ready"
        ? Math.max(action.estimatedMonthlySavingsUsd || 0, 0)
        : 0),
    0,
  );

  const diagnosticWarnings = (selected.diagnostics || [])
    .filter((diagnostic) => {
      const status = normalized(diagnostic.status);
      return status && !["ok", "success", "available", "healthy"].includes(status);
    })
    .map((diagnostic) =>
      [diagnostic.service, diagnostic.message].filter(Boolean).join(": "),
    )
    .filter(Boolean);

  const coverageSignals = [
    comparisonCostUsd > 0,
    Boolean(selected.topServices?.length),
    Boolean(selected.recommendations?.length),
    routeAttributionAvailable,
  ];

  return {
    actualCostUsd,
    projectedCostUsd,
    comparisonCostUsd,
    priorMonthCostUsd,
    changeUsd,
    changePercent,
    computeCostUsd,
    computeSharePercent,
    taxCostUsd,
    preTaxCostUsd,
    ec2OtherCostUsd,
    lightsailCostUsd,
    otherPreTaxCostUsd,
    hasPriorMonthData,
    knownMonthlySavingsUsd,
    dataTransferUsedGb: summaryNumber(selected, "dataTransferUsedGb"),
    observedOverageGb,
    observedOverageCostUsd,
    publicIpv4Count,
    publicIpv4BilledCostUsd,
    routeAttributionAvailable,
    coverageReady: coverageSignals.filter(Boolean).length,
    coverageTotal: coverageSignals.length,
    diagnosticWarnings,
    actions,
  };
};
