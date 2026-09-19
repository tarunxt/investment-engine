from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class AutoLiveTriggerUnificationTests(unittest.TestCase):
    def test_workflow_trigger_wait_is_bounded_to_thirty_minutes(self) -> None:
        source = (
            ROOT / "backend/app/domains/polymarket_auto_live/tasks.py"
        ).read_text(encoding="utf-8")

        self.assertIn("WORKFLOW_TRIGGER_RECHECK_SECONDS = 15", source)
        self.assertIn("WORKFLOW_TRIGGER_MAX_RETRIES = 120", source)
        self.assertNotIn("WORKFLOW_TRIGGER_MAX_RETRIES = 960", source)

    def test_due_scheduler_queues_both_workflow_stage1_profiles(self) -> None:
        source = (
            ROOT / "backend/app/domains/polymarket_auto_live/tasks.py"
        ).read_text(encoding="utf-8")
        section = source.split(
            "def enqueue_due_polymarket_auto_live_runs() -> None:", 1
        )[1].split(
            "def dispatch_due_auto_live_order_intents", 1
        )[0]

        self.assertIn("queue_bullpen_workflow_trigger_batch(", section)
        self.assertIn('triggered_by="scheduler"', section)
        self.assertNotIn("run = BullpenAutoLiveRun(", section)
        self.assertNotIn("publish_auto_live_task_with_fallback(", section)

        reservation_block = section.split("for state_record in due_states:", 1)[1].split(
            "for user_id in due_user_ids:", 1
        )[0]
        self.assertEqual(reservation_block.count("session.commit()"), 1)
        self.assertLess(
            reservation_block.index("due_user_ids.append(user_id)"),
            reservation_block.index("session.commit()"),
        )

    def test_trigger_batch_serializes_workflows_through_canonical_run_once(self) -> None:
        source = (
            ROOT / "backend/app/domains/polymarket_auto_live/tasks.py"
        ).read_text(encoding="utf-8")
        trigger_batch = source.split("def dispatch_bullpen_workflow_trigger_batch(", 1)[1].split(
            "def enqueue_due_polymarket_auto_live_runs", 1
        )[0]

        self.assertIn("WORKFLOW_TRIGGER_PROFILES", trigger_batch)
        self.assertIn("ACTIVE_AUTO_LIVE_RUN_STATUSES", trigger_batch)
        self.assertIn("BullpenAutoLiveBot(user_id=user_id).run_once(", trigger_batch)
        self.assertIn("source_scan_completed_at=source_completed_at", trigger_batch)

    def test_start_now_queues_this_workflow_on_latest_universal_scan(self) -> None:
        source = (
            ROOT
            / "frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx"
        ).read_text(encoding="utf-8")
        handler = source.split("  async function handleStartAutoRunNow()", 1)[1].split(
            "  async function handleStopAutoRuns()", 1
        )[0]

        self.assertIn("apiService.queueBullpenWorkflowRunNow({", handler)
        self.assertIn("workspace_profile: workspaceProfile", handler)
        self.assertNotIn("buildRunNowRequest", handler)
        self.assertNotIn("executeBullpenScan", handler)

    def test_manual_workflow_start_acknowledges_after_queue_submission(self) -> None:
        router_source = (
            ROOT / "backend/app/domains/polymarket_auto_live/router.py"
        ).read_text(encoding="utf-8")
        route = router_source.split("async def queue_workflow_run_now(", 1)[1].split(
            '@router.post("/start"', 1
        )[0]
        self.assertIn("latest_completed_universal_export", route)
        self.assertNotIn("await bot.run_once", route)
        self.assertNotIn("AutoLiveExecutionLaneBusy", route)
        self.assertIn('status="queued"', route)
        self.assertIn("universal_export_id=export_id", route)
        self.assertIn("workspace_profiles=(request.workspace_profile,)", route)

        task_source = (
            ROOT / "backend/app/domains/polymarket_auto_live/tasks.py"
        ).read_text(encoding="utf-8")
        task = task_source.split("def dispatch_bullpen_workflow_trigger_batch(", 1)[1].split(
            "def bullpen_workflow_trigger_run_id", 1
        )[0]
        self.assertIn("resolved_profiles = tuple(workspace_profiles", task)
        self.assertIn("wait_for_execution_lane=True", task)
        self.assertIn('raise self.retry(countdown=WORKFLOW_TRIGGER_RECHECK_SECONDS)', task)

    def test_dashboard_summary_selects_latest_projection_by_workspace(self) -> None:
        router_source = (
            ROOT / "backend/app/domains/polymarket_auto_live/router.py"
        ).read_text(encoding="utf-8")
        bot_source = (
            ROOT / "backend/app/domains/polymarket_auto_live/bot.py"
        ).read_text(encoding="utf-8")
        repository_source = (
            ROOT / "backend/app/domains/polymarket_auto_live/repository.py"
        ).read_text(encoding="utf-8")

        dashboard_route = router_source.split(
            "async def get_auto_live_dashboard_summary(", 1
        )[1].split('@router.get("/history"', 1)[0]
        self.assertIn("workspace_profile", dashboard_route)
        self.assertIn("_read_dashboard_summary(credentials, workspace_profile)", dashboard_route)
        self.assertIn("workspace_profile=workspace_profile", bot_source)
        latest_projection = repository_source.split(
            "async def get_latest_projected_run(", 1
        )[1].split("async def get_projected_run_for_user(", 1)[0]
        self.assertIn("_history_workspace_filter(record, workspace_profile)", latest_projection)

    def test_completed_universal_scan_queues_the_workflow_trigger_batch(self) -> None:
        source = (
            ROOT / "backend/app/domains/trading_bots/tasks.py"
        ).read_text(encoding="utf-8")
        completed = source.split("def execute_universal_polymarket_scan", 1)[1].split(
            "except UniversalScanCancelled", 1
        )[0]

        self.assertIn("state = finish_run(", completed)
        self.assertIn('state["workflow_trigger_export_id"] = writer.export_id', completed)
        self.assertIn('state["workflow_trigger_dispatched_at"] = None', completed)
        self.assertIn("ensure_completed_universal_scan_workflow_trigger(", completed)
        self.assertIn("universal_export_id=writer.export_id", completed)

    def test_completed_scan_handoff_is_repaired_by_beat_with_idempotent_run_ids(self) -> None:
        task_source = (
            ROOT / "backend/app/domains/trading_bots/tasks.py"
        ).read_text(encoding="utf-8")
        celery_source = (
            ROOT / "backend/app/infrastructure/messaging/celery_app.py"
        ).read_text(encoding="utf-8")

        ensure = task_source.split(
            "def ensure_completed_universal_scan_workflow_trigger(", 1
        )[1].split("class UniversalScanCancelled", 1)[0]
        self.assertIn('return f"universal-export-{universal_export_id}"', task_source)
        self.assertIn("bullpen_workflow_trigger_run_id(", ensure)
        self.assertIn("WORKFLOW_TRIGGER_PROFILES", ensure)
        self.assertIn("workflow_trigger_dispatched_at", ensure)
        self.assertIn("queue_bullpen_workflow_trigger_batch(", ensure)
        self.assertIn("workspace_profiles=missing_profiles", ensure)
        self.assertIn(
            "def reconcile_completed_universal_scan_workflow_triggers()",
            task_source,
        )
        self.assertIn(
            '"universal-polymarket-stage1-handoff-recovery"',
            celery_source,
        )
        self.assertIn(
            '"app.domains.trading_bots.tasks.reconcile_completed_universal_scan_workflow_triggers"',
            celery_source,
        )

    def test_live_stage1_progress_retains_lineage_and_total_market_count(self) -> None:
        engine = (
            ROOT / "backend/app/domains/polymarket_auto_live/engine.py"
        ).read_text(encoding="utf-8")
        projection = (
            ROOT / "backend/app/domains/polymarket_auto_live/console_projection.py"
        ).read_text(encoding="utf-8")

        progress = engine.split("        def report_stage1_progress(", 1)[1].split(
            "        report_stage1_progress(", 1
        )[0]
        self.assertIn("existing_stage1.outputs", progress)
        self.assertIn(
            "**(existing_stage1.outputs if existing_stage1 is not None else {})",
            progress,
        )
        self.assertIn('progress_outputs["filters_completed_at"]', progress)
        self.assertIn('progress_outputs.setdefault(\n                        "scanned_at"', progress)
        self.assertNotIn(
            '"filters_completed_at": manual_console_context.filters_completed_at',
            engine,
        )

        page_progress = engine.split("            def report_scan_page(", 1)[1].split(
            "            from app.domains.polymarket_auto_live.scan_source_store", 1
        )[0]
        self.assertIn('"totalMarkets"', page_progress)
        self.assertIn("manual_console_context.total_candidates", page_progress)

        projection_keys = projection.split("_STAGE_OUTPUT_KEYS = {", 1)[1].split(
            "}", 1
        )[0]
        for key in (
            "snapshot_id",
            "scanned_at",
            "source_scan_completed_at",
            "filters_completed_at",
        ):
            self.assertIn(f'"{key}"', projection_keys)


if __name__ == "__main__":
    unittest.main()
