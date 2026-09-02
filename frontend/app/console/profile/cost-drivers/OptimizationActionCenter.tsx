"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  CircleDollarSign,
  Gauge,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import {
  buildOptimizationReview,
  previousMonthValue,
  type CostDashboard,
  type OptimizationAction,
  type OptimizationPriority,
} from "./optimization";

type ActionStatus = "open" | "in-progress" | "done" | "deferred";
type ActionStatusMap = Record<string, ActionStatus>;

const money = (value: number) => `$${Number(value || 0).toFixed(2)}`;
const monthValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (value: string) => {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
};
const monthOptions = () => {
  const current = new Date();
  return Array.from({ length: 13 }, (_, index) => {
    const optionDate = new Date(
      current.getFullYear(),
      current.getMonth() - index,
      1,
    );
    const value = monthValue(optionDate);
    return { value, label: monthLabel(value) };
  });
};

const priorityClass: Record<OptimizationPriority, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

const statusClass: Record<ActionStatus, string> = {
  open: "border-slate-300 bg-background",
  "in-progress": "border-blue-300 bg-blue-50",
  done: "border-emerald-300 bg-emerald-50",
  deferred: "border-amber-300 bg-amber-50",
};

const actionStatusKey = (month: string) =>
  `credx-cost-optimization-status:v1:${month}`;

function ActionCard({
  action,
  status,
  onStatusChange,
}: {
  action: OptimizationAction;
  status: ActionStatus;
  onStatusChange: (status: ActionStatus) => void;
}) {
  return (
    <div className={`rounded-lg border p-4 shadow-sm ${statusClass[status]}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${priorityClass[action.priority]}`}
            >
              {action.priority} priority
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {action.category}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {action.effort} effort
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {action.confidence}
            </span>
          </div>
          <h4 className="mt-2 text-sm font-semibold">{action.title}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{action.rationale}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:items-end">
          <label
            htmlFor={`status-${action.id}`}
            className="text-xs font-medium text-muted-foreground"
          >
            Review status
          </label>
          <select
            id={`status-${action.id}`}
            value={status}
            onChange={(event) =>
              onStatusChange(event.target.value as ActionStatus)
            }
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="open">Open</option>
            <option value="in-progress">In progress</option>
            <option value="done">Done</option>
            <option value="deferred">Deferred</option>
          </select>
          <span className="text-xs text-muted-foreground">
            Saved in this browser
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_210px]">
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Next steps
          </h5>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {action.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        <div className="rounded-md border bg-background/70 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Savings status
          </p>
          <p className="mt-1 text-lg font-semibold">
            {action.estimatedMonthlySavingsUsd == null
              ? "Not yet evidenced"
              : `${money(action.estimatedMonthlySavingsUsd)}/month`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Source: {action.source}
          </p>
        </div>
      </div>
    </div>
  );
}

export function OptimizationActionCenter() {
  const months = useMemo(() => monthOptions(), []);
  const [selectedMonth, setSelectedMonth] = useState(() =>
    monthValue(new Date()),
  );
  const [selectedData, setSelectedData] = useState<CostDashboard | null>(null);
  const [previousData, setPreviousData] = useState<CostDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [actionStatuses, setActionStatuses] = useState<ActionStatusMap>({});

  const load = useCallback(
    async (refresh = false) => {
      setError(null);
      if (refresh) setRefreshing(true);
      else setLoading(true);

      try {
        const selectedRequest = refresh
          ? apiService.post<CostDashboard>(
              URLs.costDrivers.refresh(selectedMonth),
            )
          : apiService.get<CostDashboard>(
              URLs.costDrivers.summary(selectedMonth),
            );
        const previousRequest = apiService
          .get<CostDashboard>(
            URLs.costDrivers.summary(previousMonthValue(selectedMonth)),
          )
          .catch(() => null);
        const [selected, previous] = await Promise.all([
          selectedRequest,
          previousRequest,
        ]);
        setSelectedData(selected);
        setPreviousData(previous);
        setLastLoadedAt(new Date());
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load the optimisation review.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [selectedMonth],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(actionStatusKey(selectedMonth));
      setActionStatuses(saved ? (JSON.parse(saved) as ActionStatusMap) : {});
    } catch {
      setActionStatuses({});
    }
  }, [selectedMonth]);

  const review = useMemo(
    () =>
      selectedData
        ? buildOptimizationReview(selectedData, previousData)
        : null,
    [previousData, selectedData],
  );

  const updateStatus = useCallback(
    (actionId: string, status: ActionStatus) => {
      setActionStatuses((current) => {
        const next = { ...current, [actionId]: status };
        try {
          window.localStorage.setItem(
            actionStatusKey(selectedMonth),
            JSON.stringify(next),
          );
        } catch {
          // Status tracking is a convenience; the optimisation data remains usable.
        }
        return next;
      });
    },
    [selectedMonth],
  );

  if (loading && !selectedData) {
    return (
      <Card className="w-full max-w-7xl">
        <CardContent className="py-6 text-sm text-muted-foreground">
          Building the cost optimisation review…
        </CardContent>
      </Card>
    );
  }

  if (!review) {
    return (
      <Card className="w-full max-w-7xl border-red-200">
        <CardContent className="py-6 text-sm text-red-700">
          {error || "No cost optimisation data is available."}
        </CardContent>
      </Card>
    );
  }

  const isLower = review.changeUsd < 0;
  const isClosedMonth = selectedMonth < monthValue(new Date());
  const trackableActions = review.actions.filter(
    (action) => action.id !== "routine-finops-cadence",
  );
  const routineAction = review.actions.find(
    (action) => action.id === "routine-finops-cadence",
  );
  const completedActions = trackableActions.filter(
    (action) => actionStatuses[action.id] === "done",
  ).length;

  return (
    <div className="w-full max-w-7xl space-y-4">
      <Card className="border-primary/30 bg-primary/[0.02]">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Wrench className="h-5 w-5 text-primary" />
                <CardTitle>AWS cost truth &amp; savings centre</CardTitle>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Reconciles the AWS total with its service components, then ranks
                only savings that are supported by billing and inventory evidence.
              </p>
              {lastLoadedAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Review refreshed {lastLoadedAt.toLocaleString()}.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs font-medium text-muted-foreground">
                Review month
                <select
                  value={selectedMonth}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  className="mt-1 block h-9 min-w-36 rounded-md border bg-background px-2 text-sm text-foreground"
                >
                  {months.map((month) => (
                    <option key={month.value} value={month.value}>
                      {month.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load(true)}
                disabled={refreshing}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                />
                {refreshing ? "Refreshing" : "Refresh evidence"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              The latest refresh had a problem: {error}. The last successful
              review remains displayed.
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CircleDollarSign className="h-4 w-4" />
                {isClosedMonth ? "Closed-month AWS total" : "Projected month end"}
              </div>
              <p className="mt-2 text-2xl font-semibold">
                {money(review.comparisonCostUsd)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Cost Explorer actual: {money(review.actualCostUsd)}
              </p>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                {isLower ? (
                  <TrendingDown className="h-4 w-4 text-emerald-600" />
                ) : (
                  <TrendingUp className="h-4 w-4 text-amber-600" />
                )}
                Versus previous month
              </div>
              <p
                className={`mt-2 text-2xl font-semibold ${
                  isLower ? "text-emerald-700" : "text-amber-700"
                }`}
              >
                {review.changePercent == null
                  ? "Not available"
                  : `${Math.abs(review.changePercent).toFixed(1)}% ${
                      isLower ? "lower" : "higher"
                    }`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {review.hasPriorMonthData
                  ? `Prior month: ${money(review.priorMonthCostUsd)}`
                  : "No prior-month billing data loaded"}
              </p>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Gauge className="h-4 w-4" />
                Largest controllable driver
              </div>
              <p className="mt-2 text-2xl font-semibold">
                {money(review.computeCostUsd)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                EC2 compute: {review.computeSharePercent.toFixed(0)}% of pre-tax services
              </p>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CheckCircle2 className="h-4 w-4" />
                Confirmed removable cost
              </div>
              <p className="mt-2 text-2xl font-semibold text-emerald-700">
                {money(review.knownMonthlySavingsUsd)}/mo
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Unverified IP, Lightsail and EC2 ideas are excluded
              </p>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CalendarCheck2 className="h-4 w-4" />
                Review progress
              </div>
              <p className="mt-2 text-2xl font-semibold">
                {completedActions}/{trackableActions.length}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Evidence coverage: {review.coverageReady}/{review.coverageTotal}
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-semibold">AWS bill reconciliation</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Components below reconcile to the Cost Explorer total; rounded
                  daily chart values are never re-summed into the bill.
                </p>
              </div>
              <p className="text-sm font-semibold">Total {money(review.actualCostUsd)}</p>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
              {[
                ["Pre-tax services", review.preTaxCostUsd],
                ["Tax", review.taxCostUsd],
                ["EC2 compute", review.computeCostUsd],
                ["EC2 other / EBS", review.ec2OtherCostUsd],
                ["Lightsail", review.lightsailCostUsd],
                ["Other pre-tax", review.otherPreTaxCostUsd],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-base font-semibold">{money(Number(value))}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Public IPv4: {review.publicIpv4Count} in inventory; {money(review.publicIpv4BilledCostUsd)}
              {" "}matched to a Public IPv4 usage type. Inventory existence is not counted as a saving.
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div
              className={`rounded-lg border p-4 ${
                review.routeAttributionAvailable
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-300 bg-amber-50"
              }`}
            >
              <div className="flex items-start gap-2">
                {review.routeAttributionAvailable ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-700" />
                )}
                <div>
                  <p className="text-sm font-semibold">
                    {review.routeAttributionAvailable
                      ? "Route and asset attribution is active"
                      : "Route and asset attribution is missing"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {review.routeAttributionAvailable
                      ? "Transfer recommendations can be linked to specific paths, content types and user agents."
                      : "AWS transfer totals are visible, but the dashboard cannot yet identify whether media, API, JavaScript, HTML or bots caused the usage."}
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <p className="text-sm font-semibold">Billing context</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Tax is {money(review.taxCostUsd)} for this review month and is
                shown in the total but not called a direct saving. Reduce the
                underlying taxable service and the tax falls automatically.
              </p>
            </div>
          </div>

          {review.diagnosticWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">
                Checks requiring attention
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">
                {review.diagnosticWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prioritised action plan</CardTitle>
          <p className="text-sm text-muted-foreground">
            Savings are shown only where the dashboard has direct evidence.
            Production changes should be validated before execution.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {trackableActions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              status={actionStatuses[action.id] || "open"}
              onStatusChange={(status) => updateStatus(action.id, status)}
            />
          ))}
        </CardContent>
      </Card>

      {routineAction && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CalendarCheck2 className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">
                Routine cost optimisation cadence
              </CardTitle>
            </div>
            <p className="text-sm text-muted-foreground">
              Use the same control cycle every month so that identified savings
              become completed and measurable actions.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {routineAction.steps.map((step, index) => (
                <div key={step} className="rounded-lg border bg-muted/20 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Control {index + 1}
                  </p>
                  <p className="mt-2 text-sm">{step}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
