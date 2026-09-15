from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class AutoLiveTriggerUnificationTests(unittest.TestCase):
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

    def test_start_now_builds_this_workflows_latest_universal_stage1(self) -> None:
        source = (
            ROOT
            / "frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx"
        ).read_text(encoding="utf-8")
        handler = source.split("  async function handleStartAutoRunNow()", 1)[1].split(
            "  async function handleStopAutoRuns()", 1
        )[0]

        self.assertIn("const runNowRequest = await buildRunNowRequest?.();", handler)
        self.assertIn("runNowRequest.console_profile.workspace_profile !== workspaceProfile", handler)
        self.assertIn("apiService.runBullpenAutoLiveOnce(runNowRequest)", handler)

    def test_completed_universal_scan_queues_the_workflow_trigger_batch(self) -> None:
        source = (
            ROOT / "backend/app/domains/trading_bots/tasks.py"
        ).read_text(encoding="utf-8")
        completed = source.split("def execute_universal_polymarket_scan", 1)[1].split(
            "except UniversalScanCancelled", 1
        )[0]

        self.assertIn("queue_bullpen_workflow_trigger_batch(", completed)
        self.assertIn('triggered_by="universal_scan"', completed)
        self.assertIn("universal_export_id=writer.export_id", completed)


if __name__ == "__main__":
    unittest.main()
