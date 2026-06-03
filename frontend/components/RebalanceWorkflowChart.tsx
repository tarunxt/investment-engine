"use client";

import { memo, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  GitBranch,
  Layers3,
  PlayCircle,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

export type RebalanceStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "warning"
  | "blocked"
  | "skipped";

export type RebalanceEdgeKind = "primary" | "opportunity" | "risk";

export type RebalanceStageOutput = {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger" | "muted";
};

export type RebalanceWorkflowStage = {
  id: string;
  title: string;
  subtitle?: string;
  icon: keyof typeof ICONS;
  status: RebalanceStageStatus;
  position: { x: number; y: number };
  outputs: RebalanceStageOutput[];
};

export type RebalanceWorkflowEdge = {
  id: string;
  source: string;
  target: string;
  kind: RebalanceEdgeKind;
  label?: string;
};

const ICONS = {
  sync: GitBranch,
  risk: AlertTriangle,
  opportunity: Activity,
  rebalance: SlidersHorizontal,
  allocation: Layers3,
  guardrails: ShieldCheck,
  technical: BarChart3,
  actionables: ClipboardList,
  completed: CheckCircle2,
  running: PlayCircle,
} as const satisfies Record<string, LucideIcon>;

const STATUS_STYLES: Record<
  RebalanceStageStatus,
  { card: string; badge: string; icon: string; label: string }
> = {
  pending: {
    card: "border-slate-200 bg-white text-slate-900 shadow-slate-200/70",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    icon: "bg-slate-100 text-slate-600 ring-slate-200",
    label: "Pending",
  },
  running: {
    card: "border-blue-200 bg-blue-50/95 text-blue-950 shadow-blue-200/80",
    badge: "bg-blue-100 text-blue-700 ring-blue-200",
    icon: "bg-blue-600 text-white ring-blue-200",
    label: "Running",
  },
  completed: {
    card: "border-emerald-200 bg-emerald-50/95 text-emerald-950 shadow-emerald-200/80",
    badge: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    icon: "bg-emerald-600 text-white ring-emerald-200",
    label: "Completed",
  },
  warning: {
    card: "border-amber-200 bg-amber-50/95 text-amber-950 shadow-amber-200/80",
    badge: "bg-amber-100 text-amber-700 ring-amber-200",
    icon: "bg-amber-500 text-white ring-amber-200",
    label: "Warning",
  },
  blocked: {
    card: "border-red-200 bg-red-50/95 text-red-950 shadow-red-200/80",
    badge: "bg-red-100 text-red-700 ring-red-200",
    icon: "bg-red-600 text-white ring-red-200",
    label: "Blocked",
  },
  skipped: {
    card: "border-slate-200 bg-slate-50/95 text-slate-500 shadow-slate-200/60 opacity-80",
    badge: "bg-slate-100 text-slate-500 ring-slate-200",
    icon: "bg-slate-200 text-slate-500 ring-slate-200",
    label: "Skipped",
  },
};

const EDGE_STYLES: Record<RebalanceEdgeKind, { color: string; dash?: string }> = {
  primary: { color: "#2563eb" },
  opportunity: { color: "#0f766e", dash: "5 7" },
  risk: { color: "#dc2626", dash: "7 6" },
};

function outputToneClass(tone: RebalanceStageOutput["tone"]) {
  switch (tone) {
    case "success":
      return "border-emerald-100 bg-emerald-50 text-emerald-800";
    case "warning":
      return "border-amber-100 bg-amber-50 text-amber-800";
    case "danger":
      return "border-red-100 bg-red-50 text-red-800";
    case "muted":
      return "border-slate-100 bg-slate-50 text-slate-500";
    default:
      return "border-blue-100 bg-white text-slate-700";
  }
}

const NODE_WIDTH = 232;
const NODE_HEIGHT = 150;
const CANVAS_WIDTH = 1520;
const CANVAS_HEIGHT = 570;

const StageNode = memo(function StageNode({ stage }: { stage: RebalanceWorkflowStage }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[stage.icon] ?? ClipboardList;
  const styles = STATUS_STYLES[stage.status];

  return (
    <article
      className={`rebalance-workflow-node min-w-[13rem] max-w-[18rem] rounded-[1.35rem] border p-[clamp(0.8rem,3cqi,1rem)] shadow-lg ${styles.card}`}
      aria-label={`${stage.title} stage, ${styles.label}`}
    >
      <div className="flex items-start gap-[0.75em]">
        <span className={`inline-flex size-[2.35em] shrink-0 items-center justify-center rounded-[0.85em] ring-1 ${styles.icon}`}>
          <Icon className="size-[1.15em]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-[0.5em]">
            <div>
              <h3 className="text-[clamp(0.95rem,5cqi,1.15rem)] font-black leading-tight tracking-[-0.02em]">
                {stage.title}
              </h3>
              {stage.subtitle ? (
                <p className="mt-[0.25em] text-[clamp(0.75rem,3.5cqi,0.875rem)] font-semibold leading-snug text-slate-500">
                  {stage.subtitle}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-expanded={open}
              aria-label={`Toggle ${stage.title} run details`}
              className="nodrag nopan inline-flex size-[2em] shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-600 shadow-sm transition hover:bg-white hover:text-slate-950"
              onClick={(event) => {
                event.stopPropagation();
                setOpen((current) => !current);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <ChevronDown
                className={`size-[1em] transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
          <span className={`mt-[0.75em] inline-flex rounded-full px-[0.75em] py-[0.25em] text-[clamp(0.68rem,3cqi,0.78rem)] font-bold ring-1 ${styles.badge}`}>
            {styles.label}
          </span>
        </div>
      </div>

      {open ? (
        <div
          className="nodrag nopan mt-[0.9em] space-y-[0.45em] rounded-[1em] border border-slate-200 bg-white/90 p-[0.7em] text-[clamp(0.74rem,3.2cqi,0.86rem)] shadow-inner"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {stage.outputs.map((output) => (
            <div
              key={`${output.label}-${output.value}`}
              className={`rounded-[0.75em] border px-[0.75em] py-[0.55em] ${outputToneClass(output.tone)}`}
            >
              <p className="font-extrabold leading-tight">{output.label}</p>
              <p className="mt-[0.15em] leading-snug">{output.value}</p>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
});

export const DEFAULT_REBALANCE_WORKFLOW_STAGES: RebalanceWorkflowStage[] = [
  {
    id: "sync",
    title: "Sync",
    subtitle: "Pull holdings, cash, prices",
    icon: "sync",
    status: "completed",
    position: { x: 0, y: 170 },
    outputs: [
      { label: "Holdings", value: "Latest Zerodha snapshot normalized", tone: "success" },
      { label: "Cash", value: "Available balance included in allocation", tone: "default" },
      { label: "Prices", value: "Fresh market prices attached", tone: "default" },
    ],
  },
  {
    id: "risk",
    title: "Risk lane",
    subtitle: "Threats reduce exposure or block unsafe trades",
    icon: "risk",
    status: "warning",
    position: { x: 260, y: 35 },
    outputs: [
      { label: "Threat flags", value: "Drawdown, news, and concentration checks", tone: "warning" },
      { label: "Guardrail output", value: "Trim / skip if risk is high", tone: "danger" },
    ],
  },
  {
    id: "opportunity",
    title: "Opportunity lane",
    subtitle: "Swing setups raise buy/add candidates",
    icon: "opportunity",
    status: "completed",
    position: { x: 260, y: 310 },
    outputs: [
      { label: "Momentum", value: "Positive setup candidates", tone: "success" },
      { label: "Confirmation", value: "Add candidate if setup passes", tone: "success" },
    ],
  },
  {
    id: "rebalance",
    title: "Rebalance",
    subtitle: "Target vs current weights",
    icon: "rebalance",
    status: "running",
    position: { x: 560, y: 175 },
    outputs: [
      { label: "Consensus", value: "Target weights, trims, adds, cash", tone: "default" },
      { label: "Run details", value: "LLM mix outputs and costs tracked", tone: "default" },
    ],
  },
  {
    id: "allocation",
    title: "Allocation",
    subtitle: "Weights + cash decision",
    icon: "allocation",
    status: "pending",
    position: { x: 805, y: 35 },
    outputs: [
      { label: "Sizing", value: "Target weight vs current exposure", tone: "default" },
      { label: "Cash", value: "Available cash held for orders", tone: "default" },
    ],
  },
  {
    id: "guardrails",
    title: "Execution guardrails",
    subtitle: "Price trend, volume, stop checks",
    icon: "guardrails",
    status: "pending",
    position: { x: 1040, y: 70 },
    outputs: [
      { label: "Stops", value: "Blocks unsafe entries/exits", tone: "danger" },
      { label: "Liquidity", value: "Volume and price trend checks", tone: "warning" },
    ],
  },
  {
    id: "technical",
    title: "Technical",
    subtitle: "Entry / exit checks",
    icon: "technical",
    status: "pending",
    position: { x: 820, y: 310 },
    outputs: [
      { label: "Entry", value: "Breakout, support, and volume quality", tone: "success" },
      { label: "Exit", value: "Weakness and stop-loss validation", tone: "warning" },
    ],
  },
  {
    id: "actionables",
    title: "Actionables",
    subtitle: "Orders + watchlist",
    icon: "actionables",
    status: "pending",
    position: { x: 1265, y: 190 },
    outputs: [
      { label: "Buy / add", value: "Approved new orders and adds", tone: "success" },
      { label: "Sell / trim", value: "Risk-led exits or trims", tone: "danger" },
      { label: "Hold / watch", value: "No-trade watchlist candidates", tone: "muted" },
    ],
  },
];

export const DEFAULT_REBALANCE_WORKFLOW_EDGES: RebalanceWorkflowEdge[] = [
  { id: "sync-risk", source: "sync", target: "risk", kind: "risk" },
  { id: "sync-opportunity", source: "sync", target: "opportunity", kind: "opportunity" },
  { id: "risk-rebalance", source: "risk", target: "rebalance", kind: "risk" },
  { id: "opportunity-rebalance", source: "opportunity", target: "rebalance", kind: "opportunity" },
  { id: "rebalance-allocation", source: "rebalance", target: "allocation", kind: "primary" },
  { id: "rebalance-technical", source: "rebalance", target: "technical", kind: "primary" },
  { id: "allocation-guardrails", source: "allocation", target: "guardrails", kind: "risk" },
  { id: "technical-guardrails", source: "technical", target: "guardrails", kind: "opportunity" },
  { id: "guardrails-actionables", source: "guardrails", target: "actionables", kind: "primary" },
  { id: "technical-actionables", source: "technical", target: "actionables", kind: "primary" },
];

function buildEdgePath(source: RebalanceWorkflowStage, target: RebalanceWorkflowStage) {
  const startX = source.position.x + NODE_WIDTH;
  const startY = source.position.y + NODE_HEIGHT / 2;
  const endX = target.position.x;
  const endY = target.position.y + NODE_HEIGHT / 2;
  const controlOffset = Math.max(80, Math.abs(endX - startX) * 0.45);

  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;
}

export function RebalanceWorkflowChart({
  stages = DEFAULT_REBALANCE_WORKFLOW_STAGES,
  edges = DEFAULT_REBALANCE_WORKFLOW_EDGES,
  showMiniMap = true,
}: {
  stages?: RebalanceWorkflowStage[];
  edges?: RebalanceWorkflowEdge[];
  showMiniMap?: boolean;
}) {
  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);

  const renderedEdges = useMemo(
    () =>
      edges.flatMap((edge) => {
        const source = stageById.get(edge.source);
        const target = stageById.get(edge.target);
        if (!source || !target) return [];

        return [{ edge, source, target, path: buildEdgePath(source, target) }];
      }),
    [edges, stageById],
  );

  return (
    <div className="rebalance-workflow-chart h-[clamp(32rem,58vw,45rem)] min-h-[32rem] w-full overflow-auto rounded-[1.5rem] border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-blue-50/40">
      <div
        className="relative min-h-full"
        style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
        role="region"
        aria-label="Interactive Zerodha rebalance workflow graph"
      >
        <div
          className="absolute inset-0 opacity-70"
          style={{
            backgroundImage: "radial-gradient(circle, #dbeafe 1.2px, transparent 1.2px)",
            backgroundSize: "24px 24px",
          }}
          aria-hidden="true"
        />
        <svg
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
          aria-hidden="true"
        >
          <defs>
            {Object.entries(EDGE_STYLES).map(([kind, style]) => (
              <marker
                key={kind}
                id={`rebalance-arrow-${kind}`}
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={style.color} />
              </marker>
            ))}
          </defs>
          {renderedEdges.map(({ edge, path }) => {
            const edgeStyle = EDGE_STYLES[edge.kind];
            return (
              <path
                key={edge.id}
                d={path}
                fill="none"
                stroke={edgeStyle.color}
                strokeWidth={edge.kind === "primary" ? 4 : 3}
                strokeDasharray={edgeStyle.dash}
                markerEnd={`url(#rebalance-arrow-${edge.kind})`}
              />
            );
          })}
        </svg>

        {stages.map((stage) => (
          <div
            key={stage.id}
            className="absolute"
            style={{ left: stage.position.x, top: stage.position.y, width: NODE_WIDTH }}
          >
            <StageNode stage={stage} />
          </div>
        ))}

        {showMiniMap ? (
          <div className="absolute bottom-4 right-4 rounded-xl border border-slate-200 bg-white/85 px-3 py-2 text-xs font-bold text-slate-500 shadow-sm backdrop-blur">
            Scroll or resize to inspect the full workflow
          </div>
        ) : null}
      </div>
    </div>
  );
}
