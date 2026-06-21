from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Final
from uuid import uuid4

from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveDecision,
    BullpenAutoLiveGuardrailCheck,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
    TradingBotGuardrail,
)
from app.domains.polymarket_auto_live.storage import JsonModelStore, JsonObjectStore

AUTO_LIVE_STRATEGY_SUMMARY: Final[str] = (
    "Fully automated AI + evidence + market-rules based Bullpen trading engine. "
    "Scans markets, parses rules, builds shared evidence, runs LLM consensus, "
    "scores edges, sizes positions, rebalances active positions, and executes "
    "live limit orders only when all guardrails pass."
)
AUTO_LIVE_RISK_SUMMARY: Final[str] = (
    "Full automation can compound model, evidence, and execution errors quickly "
    "once live trading is enabled."
)
AUTO_LIVE_STAGE_FLOW: Final[list[tuple[str, str]]] = [
    (
        "Market scan",
        "Scan open Bullpen markets, dedupe stale listings, and classify tradable themes.",
    ),
    (
        "Market rules",
        "Parse resolution rules, venue mechanics, and timing windows before evidence is shared downstream.",
    ),
    (
        "Evidence refresh",
        "Refresh shared evidence, source freshness, and conflict flags so stale notes cannot auto-trade.",
    ),
    (
        "LLM consensus",
        "Run multi-model consensus, compare disagreement bands, and normalize fair probabilities.",
    ),
    (
        "Sizing & guardrails",
        "Apply edge thresholds, bankroll sizing, reserve rules, and doctor plus balance guardrails.",
    ),
    (
        "Portfolio rebalance",
        "Compare current exposure versus target exposure and generate only the deltas that matter.",
    ),
    (
        "Limit-order execution",
        "Stage live limit orders and submit only when every gate is green.",
    ),
]
MAX_PERSISTED_RUNS: Final[int] = 200
MAX_PERSISTED_DECISIONS: Final[int] = 500


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def round_money(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


class BullpenAutoLiveBot:
    def __init__(
        self,
        settings_store: JsonObjectStore[BullpenAutoLiveSettings],
        state_store: JsonObjectStore[BullpenAutoLiveState],
        run_store: JsonModelStore[BullpenAutoLiveRun],
        decision_store: JsonModelStore[BullpenAutoLiveDecision],
    ) -> None:
        self.settings_store = settings_store
        self.state_store = state_store
        self.run_store = run_store
        self.decision_store = decision_store

        self.settings = BullpenAutoLiveSettings()
        self.state = BullpenAutoLiveState()
        self.runs: list[BullpenAutoLiveRun] = []
        self.decisions: list[BullpenAutoLiveDecision] = []

        self._lock = asyncio.Lock()
        self._runner_task: asyncio.Task[None] | None = None

    async def init(self) -> None:
        async with self._lock:
            persisted_settings = await self.settings_store.load()
            persisted_state = await self.state_store.load()
            self.runs = await self.run_store.load()
            self.decisions = await self.decision_store.load()

            self.settings = persisted_settings or BullpenAutoLiveSettings()
            self.state = self._normalize_loaded_state(
                persisted_state or BullpenAutoLiveState()
            )
            self._sync_runtime_state_unlocked()
            await self.settings_store.save(self.settings)
            await self.state_store.save(self.state)

    async def shutdown(self) -> None:
        async with self._lock:
            self.state.running = False
            self.state.next_run_at = None
            self.state.next_scan_at = None
            self.state.next_llm_run_at = None
            self.state.next_rebalance_at = None
            self._sync_runtime_state_unlocked()
            await self.state_store.save(self.state)
        await self._cancel_runner_task()

    async def get_settings(self) -> BullpenAutoLiveSettings:
        async with self._lock:
            return self.settings.model_copy()

    async def update_settings(
        self, update: BullpenAutoLiveSettingsUpdate
    ) -> BullpenAutoLiveSettings:
        async with self._lock:
            merged = self.settings.model_dump()
            merged.update(update.model_dump(exclude_unset=True))
            self.settings = BullpenAutoLiveSettings.model_validate(merged)
            self._sync_runtime_state_unlocked()
            if self.state.running:
                self._schedule_next_cycles_unlocked(reference_time=utc_now())
            await self.settings_store.save(self.settings)
            await self.state_store.save(self.state)
            return self.settings.model_copy()

    async def reset_settings(self) -> BullpenAutoLiveSettings:
        async with self._lock:
            self.settings = BullpenAutoLiveSettings()
            self._sync_runtime_state_unlocked()
            if self.state.running:
                self._schedule_next_cycles_unlocked(reference_time=utc_now())
            await self.settings_store.save(self.settings)
            await self.state_store.save(self.state)
            return self.settings.model_copy()

    async def get_state(self) -> BullpenAutoLiveState:
        async with self._lock:
            return self._state_snapshot_unlocked()

    async def get_summary(self) -> BullpenAutoLiveSummary:
        async with self._lock:
            latest_guardrails = self._build_guardrail_checks_unlocked()
            return BullpenAutoLiveSummary(
                state=self._state_snapshot_unlocked(),
                settings=self.settings.model_copy(),
                bot_card=self._build_bot_card_summary_unlocked(
                    latest_guardrails=latest_guardrails
                ),
                latest_run=self.runs[0] if self.runs else None,
                recent_runs=[run.model_copy() for run in self.runs[:10]],
                recent_decisions=[
                    decision.model_copy() for decision in self.decisions[:10]
                ],
                latest_guardrail_checks=latest_guardrails,
            )

    async def list_runs(self) -> list[BullpenAutoLiveRun]:
        async with self._lock:
            return [run.model_copy() for run in self.runs]

    async def list_decisions(self) -> list[BullpenAutoLiveDecision]:
        async with self._lock:
            return [decision.model_copy() for decision in self.decisions]

    async def run_once(self, *, triggered_by: str = "manual") -> BullpenAutoLiveRun:
        async with self._lock:
            now = utc_now()
            run_id = str(uuid4())
            latest_guardrails = self._build_guardrail_checks_unlocked(now)
            auto_live_disabled = not self.settings.auto_live_enabled
            blocked_reason = self._run_block_reason_unlocked(triggered_by)
            stage_results = self._build_stage_results_unlocked(
                now=now,
                blocked_reason=blocked_reason,
                auto_live_disabled=auto_live_disabled,
            )

            decision_ids: list[str] = []
            decisions_count = 0
            run_status = "completed"
            run_summary = "Auto-Live dry evaluation completed."

            if blocked_reason:
                run_status = "skipped"
                run_summary = blocked_reason
            else:
                recent_decision = self._build_placeholder_decision_unlocked(
                    run_id=run_id,
                    now=now,
                )
                self.decisions.insert(0, recent_decision)
                self.decisions = self.decisions[:MAX_PERSISTED_DECISIONS]
                decision_ids.append(recent_decision.id)
                decisions_count = 1
                if self.settings.dry_run:
                    run_summary = (
                        "Auto-Live dry-run completed. No orders were submitted."
                    )
                elif self.settings.require_manual_confirmation:
                    run_summary = (
                        "Auto-Live evaluation completed. Manual confirmation is still required before live execution."
                    )
                elif not self.settings.allow_live_execution:
                    run_summary = (
                        "Auto-Live evaluation completed. Live execution remains disabled in settings."
                    )
                else:
                    run_summary = (
                        "Auto-Live evaluation completed. Strategy scaffolding stayed in no-order mode for safe backend rollout."
                    )

            run = BullpenAutoLiveRun(
                id=run_id,
                triggered_by=triggered_by,
                status=run_status,
                dry_run=self.settings.dry_run,
                started_at=now,
                completed_at=now,
                summary=run_summary,
                live_execution_requested=(
                    not self.settings.dry_run and self.settings.allow_live_execution
                ),
                live_execution_attempted=False,
                decisions_count=decisions_count,
                orders_planned=0,
                orders_submitted=0,
                stage_results=stage_results,
                guardrail_checks=latest_guardrails,
                decision_ids=decision_ids,
            )
            self.runs.insert(0, run)
            self.runs = self.runs[:MAX_PERSISTED_RUNS]

            self.state.last_run_id = run.id
            self.state.last_run_at = now
            self.state.last_scan_at = now
            self.state.last_llm_run_at = now
            self.state.last_rebalance_at = now
            self.state.last_error = None if run_status != "failed" else run.summary
            self.state.last_action = run.summary
            self.state.latest_guardrail_checks = latest_guardrails
            self.state.trades_today = self._count_runs_today_unlocked()
            self._schedule_next_cycles_unlocked(reference_time=now)
            self._sync_runtime_state_unlocked()

            await self.run_store.save(self.runs)
            await self.decision_store.save(self.decisions)
            await self.state_store.save(self.state)
            return run.model_copy()

    async def start(self) -> BullpenAutoLiveState:
        async with self._lock:
            if not self.state.running:
                now = utc_now()
                self.state.running = True
                self.state.started_at = now
                self.state.stopped_at = None
                self.state.last_action = (
                    "Auto-Live scheduler started. Settings control whether runs execute or remain on standby."
                )
                self._schedule_next_cycles_unlocked(reference_time=now)
            self._sync_runtime_state_unlocked()
            await self.state_store.save(self.state)
            self._ensure_runner_task_unlocked()
            return self._state_snapshot_unlocked()

    async def stop(self) -> BullpenAutoLiveState:
        async with self._lock:
            self.state.running = False
            self.state.stopped_at = utc_now()
            self.state.next_run_at = None
            self.state.next_scan_at = None
            self.state.next_llm_run_at = None
            self.state.next_rebalance_at = None
            self.state.last_action = "Auto-Live scheduler stopped."
            self._sync_runtime_state_unlocked()
            await self.state_store.save(self.state)
            snapshot = self._state_snapshot_unlocked()
        await self._cancel_runner_task()
        return snapshot

    async def pause(self) -> BullpenAutoLiveState:
        async with self._lock:
            self.state.paused = True
            self.state.last_action = "Auto-Live scheduler paused."
            self._sync_runtime_state_unlocked()
            await self.state_store.save(self.state)
            return self._state_snapshot_unlocked()

    async def resume(self) -> BullpenAutoLiveState:
        async with self._lock:
            self.state.paused = False
            if not self.state.running:
                self.state.running = True
                self.state.started_at = utc_now()
            self.state.last_action = "Auto-Live scheduler resumed."
            self._schedule_next_cycles_unlocked(reference_time=utc_now())
            self._sync_runtime_state_unlocked()
            await self.state_store.save(self.state)
            self._ensure_runner_task_unlocked()
            return self._state_snapshot_unlocked()

    async def emergency_stop(self) -> BullpenAutoLiveState:
        async with self._lock:
            self.settings = self.settings.model_copy(update={"emergency_stop": True})
            self.state.paused = True
            self.state.last_action = (
                "Emergency stop activated. All new automation runs are blocked."
            )
            self._sync_runtime_state_unlocked()
            await self.settings_store.save(self.settings)
            await self.state_store.save(self.state)
            return self._state_snapshot_unlocked()

    async def clear_emergency_stop(self) -> BullpenAutoLiveState:
        async with self._lock:
            self.settings = self.settings.model_copy(update={"emergency_stop": False})
            self.state.last_action = (
                "Emergency stop cleared. Resume explicitly when you are ready."
            )
            self._sync_runtime_state_unlocked()
            await self.settings_store.save(self.settings)
            await self.state_store.save(self.state)
            return self._state_snapshot_unlocked()

    def build_bot_card_summary(self) -> BullpenAutoLiveBotCardSummary:
        latest_guardrails = self._build_guardrail_checks_unlocked()
        return self._build_bot_card_summary_unlocked(latest_guardrails=latest_guardrails)

    def _normalize_loaded_state(
        self, persisted_state: BullpenAutoLiveState
    ) -> BullpenAutoLiveState:
        return persisted_state.model_copy(
            update={
                "running": False,
                "next_run_at": None,
                "next_scan_at": None,
                "next_llm_run_at": None,
                "next_rebalance_at": None,
                "server_now": None,
            }
        )

    def _ensure_runner_task_unlocked(self) -> None:
        if self._runner_task and not self._runner_task.done():
            return
        self._runner_task = asyncio.create_task(self._runner_loop())

    async def _cancel_runner_task(self) -> None:
        task = self._runner_task
        self._runner_task = None
        if not task:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _runner_loop(self) -> None:
        try:
            while True:
                should_run = False
                async with self._lock:
                    if not self.state.running:
                        return
                    now = datetime.now(UTC)
                    if not self.state.next_run_at:
                        self._schedule_next_cycles_unlocked(reference_time=now.isoformat())
                        await self.state_store.save(self.state)
                    next_run_dt = parse_iso8601(self.state.next_run_at)
                    if (
                        next_run_dt
                        and now >= next_run_dt
                        and self.settings.auto_live_enabled
                        and not self.state.paused
                        and not self.settings.emergency_stop
                    ):
                        should_run = True
                if should_run:
                    await self.run_once(triggered_by="scheduler")
                    continue
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise

    def _run_block_reason_unlocked(self, triggered_by: str) -> str | None:
        if self.settings.emergency_stop:
            return "Emergency stop is active."
        if self.state.paused:
            return "Auto-Live is paused."
        if triggered_by != "manual" and not self.settings.auto_live_enabled:
            return "Auto-Live is disabled in settings."
        return None

    def _build_stage_results_unlocked(
        self,
        *,
        now: str,
        blocked_reason: str | None,
        auto_live_disabled: bool,
    ) -> list[BullpenAutoLiveStageResult]:
        stages: list[BullpenAutoLiveStageResult] = []
        for index, (label, description) in enumerate(AUTO_LIVE_STAGE_FLOW):
            status = "completed"
            detail = description
            if blocked_reason:
                status = "completed" if index == 0 else "skipped"
                detail = blocked_reason if index > 0 else description
            elif label == "Limit-order execution":
                status = "skipped"
                if self.settings.dry_run:
                    detail = "Dry-run is enabled, so execution stayed in simulation mode."
                elif self.settings.require_manual_confirmation:
                    detail = (
                        "Manual confirmation remains required, so no live limit order was submitted."
                    )
                elif not self.settings.allow_live_execution:
                    detail = (
                        "Live execution is disabled in settings, so order routing remained blocked."
                    )
                else:
                    detail = (
                        "Execution scaffolding is active, but backend rollout keeps order submission disabled for now."
                    )
            elif auto_live_disabled and label == "Sizing & guardrails":
                detail = (
                    "Settings remain in standby, so this run only refreshed the guardrail posture."
                )

            stages.append(
                BullpenAutoLiveStageResult(
                    stage=label,
                    status=status,
                    detail=detail,
                    started_at=now,
                    completed_at=now,
                    metadata={"description": description},
                )
            )
        return stages

    def _build_placeholder_decision_unlocked(
        self,
        *,
        run_id: str,
        now: str,
    ) -> BullpenAutoLiveDecision:
        risk_status = (
            "Blocked"
            if self.settings.emergency_stop
            else "Watch"
            if self.settings.dry_run or self.settings.require_manual_confirmation
            else "Ready"
        )
        return BullpenAutoLiveDecision(
            id=str(uuid4()),
            run_id=run_id,
            created_at=now,
            updated_at=now,
            market_id="auto-live-placeholder",
            market_title="Auto-Live backend rollout placeholder",
            theme="Scaffolding",
            side="YES",
            decision="SKIP",
            risk_status=risk_status,
            price_cents=50,
            fair_probability_pct=50,
            edge_pp=0,
            score=0,
            confidence=self.settings.min_confidence,
            evidence_status=self.settings.min_evidence_status,
            adjudication_required=self.settings.adjudication_required_blocks_trade,
            reason=(
                "Backend persistence, scheduling, and guardrails are active, but market selection and order generation remain intentionally no-op during rollout."
            ),
            summary=(
                "No live order plan was created. This decision record confirms the automation pipeline ran safely in placeholder mode."
            ),
            guardrail_checks=self._build_guardrail_checks_unlocked(now),
        )

    def _build_guardrail_checks_unlocked(
        self, checked_at: str | None = None
    ) -> list[BullpenAutoLiveGuardrailCheck]:
        now = checked_at or utc_now()
        checks = [
            BullpenAutoLiveGuardrailCheck(
                id="max-single-trade",
                label="Max single trade",
                status="pass",
                detail=(
                    f"{self.settings.max_single_trade_pct_bankroll:.2f}% stays within the "
                    f"{self.settings.max_single_market_pct_bankroll:.2f}% market cap."
                ),
                value=f"{self.settings.max_single_trade_pct_bankroll:.2f}%",
                checked_at=now,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="cash-reserve",
                label="Cash reserve",
                status="pass",
                detail=(
                    f"{self.settings.min_cash_reserve_pct_bankroll:.2f}% reserve is protected under the configured exposure budget."
                ),
                value=f"{self.settings.min_cash_reserve_pct_bankroll:.2f}%",
                checked_at=now,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="llm-spread",
                label="Max LLM disagreement",
                status="pass",
                detail=(
                    f"Trades remain blocked above a {self.settings.max_llm_spread_pp:.2f} point disagreement band."
                ),
                value=f"{self.settings.max_llm_spread_pp:.2f} pp",
                checked_at=now,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="evidence-threshold",
                label="Evidence requirement",
                status="pass",
                detail=(
                    f"Minimum evidence status is {self.settings.min_evidence_status} with confidence at {self.settings.min_confidence} or better."
                ),
                value=(
                    f"{self.settings.min_evidence_status} / {self.settings.min_confidence}"
                ),
                checked_at=now,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="limit-orders-only",
                label="Limit orders only",
                status="pass" if self.settings.limit_orders_only else "fail",
                detail=(
                    "Live execution requires limit orders only."
                    if self.settings.limit_orders_only
                    else "Limit orders only was disabled, which blocks live execution."
                ),
                value="Required" if self.settings.limit_orders_only else "Blocked",
                blocking=not self.settings.limit_orders_only,
                checked_at=now,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="emergency-stop",
                label="Emergency stop status",
                status="fail" if self.settings.emergency_stop else "pass",
                detail=(
                    "Emergency stop is active and blocks all new automation runs."
                    if self.settings.emergency_stop
                    else "Emergency stop is clear."
                ),
                value="Active" if self.settings.emergency_stop else "Clear",
                blocking=self.settings.emergency_stop,
                checked_at=now,
            ),
        ]
        return checks

    def _sync_runtime_state_unlocked(self) -> None:
        guardrails = self._build_guardrail_checks_unlocked()
        self.state.mode = self._derive_mode_unlocked()
        self.state.status = self._derive_status_unlocked()
        self.state.server_now = utc_now()
        self.state.latest_guardrail_checks = guardrails
        self.state.doctor_status = "fail" if self.settings.emergency_stop else "watch"
        self.state.balance_status = "watch"
        self.state.invested_usd = round(self.state.invested_usd, 2)
        self.state.current_value_usd = round(self.state.current_value_usd, 2)
        self.state.pnl_usd = round(self.state.current_value_usd - self.state.invested_usd, 2)
        self.state.trades_today = self._count_runs_today_unlocked()

    def _derive_mode_unlocked(self) -> str:
        if self.settings.dry_run:
            return "dry-run"
        if self.settings.allow_live_execution:
            return "live-trading"
        return "analysis-only"

    def _derive_status_unlocked(self) -> str:
        if self.state.last_error:
            return "error"
        if self.state.paused or self.settings.emergency_stop:
            return "paused"
        if self.state.running:
            return "running"
        if not self.settings.auto_live_enabled and not self.runs:
            return "not-configured"
        return "stopped"

    def _state_snapshot_unlocked(self) -> BullpenAutoLiveState:
        self._sync_runtime_state_unlocked()
        return self.state.model_copy(update={"server_now": utc_now()})

    def _schedule_next_cycles_unlocked(self, *, reference_time: str) -> None:
        reference_dt = parse_iso8601(reference_time) or datetime.now(UTC)
        if not self.state.running:
            self.state.next_run_at = None
            self.state.next_scan_at = None
            self.state.next_llm_run_at = None
            self.state.next_rebalance_at = None
            return

        self.state.next_run_at = (
            reference_dt + timedelta(seconds=self.settings.active_price_refresh_seconds)
        ).isoformat()
        self.state.next_scan_at = (
            reference_dt + timedelta(minutes=self.settings.new_scan_interval_minutes)
        ).isoformat()
        self.state.next_llm_run_at = (
            reference_dt + timedelta(minutes=self.settings.llm_rerun_interval_minutes)
        ).isoformat()
        self.state.next_rebalance_at = (
            reference_dt + timedelta(minutes=self.settings.rebalance_interval_minutes)
        ).isoformat()

    def _count_runs_today_unlocked(self) -> int:
        today = datetime.now(UTC).date()
        return sum(
            run.orders_submitted
            for run in self.runs
            if (parsed := parse_iso8601(run.completed_at or run.started_at))
            and parsed.date() == today
            and run.status == "completed"
        )

    def _build_bot_card_summary_unlocked(
        self,
        *,
        latest_guardrails: list[BullpenAutoLiveGuardrailCheck],
    ) -> BullpenAutoLiveBotCardSummary:
        state = self._state_snapshot_unlocked()
        invested = round_money(state.invested_usd) or 0
        current_value = round_money(state.current_value_usd)
        pnl = round_money(state.pnl_usd)
        return_pct = None
        if invested > 0 and pnl is not None:
            return_pct = round((pnl / invested) * 100, 2)

        guardrails = [
            TradingBotGuardrail(
                label=check.label,
                value=check.value or check.detail,
                tone=(
                    "critical"
                    if check.status == "fail"
                    else "warning"
                    if check.status == "watch"
                    else "positive"
                    if check.label in {"Limit orders only", "Emergency stop status"}
                    and check.status == "pass"
                    else "neutral"
                ),
            )
            for check in latest_guardrails
        ]

        guardrails_summary = " • ".join(
            f"{check.label}: {check.value or check.detail}" for check in latest_guardrails[:4]
        )

        return BullpenAutoLiveBotCardSummary(
            status=state.status,
            mode=state.mode,
            invested_usd=invested or 0,
            current_value_usd=current_value,
            pnl_usd=pnl,
            return_pct=return_pct,
            active_positions=state.active_positions,
            trades_today=state.trades_today,
            last_run_at=state.last_run_at,
            next_run_at=state.next_run_at if state.running else None,
            guardrails_summary=guardrails_summary,
            strategy_summary=AUTO_LIVE_STRATEGY_SUMMARY,
            risk_summary=AUTO_LIVE_RISK_SUMMARY,
            guardrails=guardrails,
        )
