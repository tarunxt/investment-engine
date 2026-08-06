from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class AutoLiveTriggerUnificationTests(unittest.TestCase):
    def test_due_scheduler_delegates_to_canonical_run_once_template(self) -> None:
        source = (
            ROOT / "backend/app/domains/polymarket_auto_live/tasks.py"
        ).read_text(encoding="utf-8")
        section = source.split(
            "def enqueue_due_polymarket_auto_live_runs() -> None:", 1
        )[1].split(
            "def dispatch_due_auto_live_order_intents", 1
        )[0]

        self.assertIn("BullpenAutoLiveBot(user_id=user_id).run_once(", section)
        self.assertIn('triggered_by="scheduler"', section)
        self.assertNotIn("run = BullpenAutoLiveRun(", section)
        self.assertNotIn("publish_auto_live_task_with_fallback(", section)

    def test_scheduler_trigger_reuses_an_existing_active_run(self) -> None:
        source = (
            ROOT / "backend/app/domains/polymarket_auto_live/bot.py"
        ).read_text(encoding="utf-8")
        run_once = source.split("    async def run_once(", 1)[1].split(
            "    async def start(", 1
        )[0]

        self.assertIn("Canonical full Auto-Live run template", run_once)
        self.assertIn('if triggered_by == "scheduler":', run_once)
        self.assertIn("return running_run", run_once)

    def test_start_now_queues_backend_template_without_browser_scan_wait(self) -> None:
        source = (
            ROOT
            / "frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx"
        ).read_text(encoding="utf-8")
        handler = source.split("  async function handleStartAutoRunNow()", 1)[1].split(
            "  async function handleStopAutoRuns()", 1
        )[0]

        self.assertIn("await apiService.startBullpenAutoLive();", handler)
        self.assertIn("apiService.runBullpenAutoLiveOnce();", handler)
        self.assertNotIn("buildRunNowRequest", handler)


if __name__ == "__main__":
    unittest.main()
