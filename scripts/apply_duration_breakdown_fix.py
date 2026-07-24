from pathlib import Path

WORKFLOW_PATH = Path("frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx")
TEST_PATH = Path("frontend/tests/dashboard-refresh-errors.test.mjs")

source = WORKFLOW_PATH.read_text(encoding="utf-8")
import_anchor = 'import { normalizeError } from "./dashboardOverviewUtils";\n'
import_line = 'import { StageDurationBreakdownDialog } from "./StageDurationBreakdownDialog";\n'
if import_line not in source:
    if source.count(import_anchor) != 1:
        raise RuntimeError("Could not find the dashboard overview import anchor exactly once")
    source = source.replace(import_anchor, import_anchor + import_line, 1)

start = source.index("function WorkflowStageTile(")
end = source.index("\nfunction ZerodhaBasketPreviewDialog", start)
tile = source[start:end]

state_anchor = '  const [openErrorDetail, setOpenErrorDetail] = useState<string | null>(null);\n\n  return (\n'
if tile.count(state_anchor) != 1:
    raise RuntimeError("Could not find the WorkflowStageTile state anchor exactly once")
state_replacement = '''  const [openErrorDetail, setOpenErrorDetail] = useState<string | null>(null);
  const [durationDialogOpen, setDurationDialogOpen] = useState(false);
  const closeDurationDialog = useCallback(
    () => setDurationDialogOpen(false),
    [],
  );
  const stageRows =
    info.state === "idle" || info.state === "queued"
      ? getIdleStageRows(stage, info, now)
      : LLM_STAGE_TILE_KEYS.has(stage)
        ? getLlmStageTileRows(info, now)
        : stage === "actionables"
          ? getActionablesStageTileRows(info)
          : getIdleStageRows(stage, info, now);

  const renderStageRow = (row: StageTileRow) => {
    if (row.label === "Duration") {
      return (
        <p key={row.label}>
          <span
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-label={`Show duration breakdown for ${stageMeta.idle}`}
            title="Show duration breakdown"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDurationDialogOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                setDurationDialogOpen(true);
              }
            }}
            className="inline-flex cursor-pointer items-baseline rounded px-0.5 text-blue-700 underline decoration-blue-300 underline-offset-2 transition hover:text-blue-800 hover:decoration-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <span className="font-semibold">{row.label}:</span>{" "}
            {row.value}
          </span>
        </p>
      );
    }

    return (
      <p
        key={row.label}
        className={
          row.label === "Error" && row.value !== "None"
            ? "text-red-700"
            : undefined
        }
      >
        <span className="font-semibold text-slate-600">
          {row.label}:
        </span>{" "}
        {row.label === "Error" && row.detail ? (
          <span className="relative inline-flex align-middle">
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpenErrorDetail((current) =>
                  current === row.detail ? null : (row.detail ?? null),
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpenErrorDetail((current) =>
                    current === row.detail ? null : (row.detail ?? null),
                  );
                }
              }}
              className="cursor-pointer rounded text-red-700 underline decoration-red-300 underline-offset-2 transition hover:text-red-800 hover:decoration-red-500 focus:outline-none focus:ring-2 focus:ring-red-200"
              aria-label="Show detailed LLM error"
              title="Show detailed LLM error"
            >
              {row.value}
            </span>
            {openErrorDetail === row.detail ? (
              <span className="absolute left-0 top-6 z-30 w-96 max-w-[calc(100vw-4rem)] rounded-2xl border border-red-100 bg-white p-4 text-xs leading-5 text-slate-700 shadow-xl shadow-slate-900/10">
                <span className="block font-bold text-red-700">
                  Detailed LLM error
                </span>
                {row.errorDetails?.length ? (
                  <span className="mt-2 block space-y-3">
                    {row.errorDetails.map((detail, index) => (
                      <span
                        key={`${detail.provider ?? "unknown"}-${detail.model ?? "unknown"}-${detail.jobId ?? index}`}
                        className="block rounded-xl border border-red-100 bg-red-50/50 p-3"
                      >
                        <span className="block font-semibold text-slate-900">
                          LLM:{" "}
                          {[
                            detail.provider || "Unknown provider",
                            detail.model || "Unknown model",
                          ].join(" / ")}
                        </span>
                        {detail.jobId || detail.status ? (
                          <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-slate-500">
                            {detail.jobId
                              ? `Job #${detail.jobId}`
                              : "Workflow error"}
                            {detail.status ? ` · Status: ${detail.status}` : ""}
                          </span>
                        ) : null}
                        <span className="mt-2 block whitespace-pre-wrap break-words">
                          {detail.message}
                        </span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="mt-1 block whitespace-pre-wrap break-words">
                    {row.detail}
                  </span>
                )}
              </span>
            ) : null}
          </span>
        ) : (
          <span>{row.value}</span>
        )}
      </p>
    );
  };

  return (
    <>
'''
tile = tile.replace(state_anchor, state_replacement, 1)

rows_start_marker = '      <div className="mt-6 w-full space-y-2 text-sm leading-5 text-slate-600">'
rows_start = tile.index(rows_start_marker)
rows_end = tile.index("\n\n      {onSyncNowClick", rows_start)
tile = (
    tile[:rows_start]
    + '''      <div className="mt-6 w-full space-y-2 text-sm leading-5 text-slate-600">
        {stageRows.map(renderStageRow)}
      </div>'''
    + tile[rows_end:]
)

closing = '''      </div>
    </button>
  );
}'''
if not tile.endswith(closing):
    raise RuntimeError("Could not find the WorkflowStageTile closing block")
tile = tile[: -len(closing)] + '''      </div>
    </button>
    <StageDurationBreakdownDialog
      open={durationDialogOpen}
      stageLabel={stageMeta.idle}
      info={info}
      now={now}
      onClose={closeDurationDialog}
    />
    </>
  );
}'''

source = source[:start] + tile + source[end:]
WORKFLOW_PATH.write_text(source, encoding="utf-8")

test_source = TEST_PATH.read_text(encoding="utf-8")
test_name = 'test("stage Duration opens a dedicated breakdown dialog without navigating the tile"'
if test_name not in test_source:
    test_source += '''

test("stage Duration opens a dedicated breakdown dialog without navigating the tile", () => {
  const workflowSource = read(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
  );
  const dialogSource = read(
    "../app/console/dashboard/_components/StageDurationBreakdownDialog.tsx",
  );

  assert.match(workflowSource, /row\.label === "Duration"/);
  assert.match(
    workflowSource,
    /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setDurationDialogOpen\(true\);/,
  );
  assert.match(workflowSource, /<StageDurationBreakdownDialog/);
  assert.match(workflowSource, /onClick\?\.\(\);/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /Stage setup and LLM dispatch/);
  assert.match(dialogSource, /LLM execution/);
  assert.match(dialogSource, /Validation, aggregation and finalisation/);
  assert.match(dialogSource, /providers run in parallel/);

  transpileTypeScript(
    "../app/console/dashboard/_components/StageDurationBreakdownDialog.tsx",
  );
});
'''
    TEST_PATH.write_text(test_source, encoding="utf-8")

Path(".github/workflows/apply-duration-breakdown-fix.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
