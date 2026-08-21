from __future__ import annotations

from datetime import UTC, datetime

from app.domains.polymarket.schemas import PolymarketBotState as BullpenPolymarketState
from app.domains.polymarket.service import polymarket_bot_manager
from app.domains.polymarket_auto_live.bot import (
    AUTO_LIVE_RISK_SUMMARY,
    AUTO_LIVE_STRATEGY_SUMMARY,
)
from app.domains.polymarket_auto_live.service import polymarket_auto_live_bot_manager
from app.domains.polymarket_direct.schemas import PolymarketBotState as DirectPolymarketState
from app.domains.polymarket_direct.service import polymarket_direct_bot_manager
from app.domains.trading_bots.schemas import (
    TradingBotCardSummary,
    TradingBotGuardrail,
    TradingBotOverviewCard,
    TradingBotsOverviewResponse,
    TradingBotsSummaryResponse,
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def round_money(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


def format_money(value: float | None) -> str:
    if value is None:
        return "—"
    return f"${value:,.2f}"


def format_integer(value: int | None) -> str:
    if value is None:
        return "—"
    return f"{value:,}"


def map_polymarket_mode(mode: str) -> str:
    if mode == "live-read":
        return "live-read"
    if mode == "live-trading":
        return "live-trading"
    return "paper"


def is_bullpen_login_required(text: str) -> bool:
    lowered = text.lower()
    return (
        "bullpen login required" in lowered
        or "run: bullpen login" in lowered
        or "session expired" in lowered
    )


def is_direct_execution_not_configured(text: str) -> bool:
    lowered = text.lower()
    return "direct execution not configured" in lowered or "login required" in lowered


def count_polymarket_trades_today(state: BullpenPolymarketState | DirectPolymarketState) -> int:
    today = datetime.now(UTC).date()

    def is_today(value: str | None) -> bool:
        if not value:
            return False
        try:
            return datetime.fromisoformat(value).date() == today
        except ValueError:
            return False

    history_count = sum(1 for trade in state.trade_history if is_today(trade.timestamp))
    recent_decision_count = sum(
        1
        for trade in state.live.recent_decisions
        if is_today(trade.executed_at or trade.proposed_at)
    )
    return max(state.live.live_trades_today or 0, history_count + recent_decision_count)


def get_polymarket_status(
    state: BullpenPolymarketState | DirectPolymarketState, *, variant: str
) -> str:
    live_error = state.live.source_status.last_live_read_error or ""
    signal_text = " ".join(
        item
        for item in (
            state.last_error,
            state.live.doctor.message,
            state.live.balance.message,
            live_error,
        )
        if item
    ).lower()

    if variant == "direct" and not state.running and is_direct_execution_not_configured(
        signal_text
    ):
        return "not-configured"
    if state.last_error:
        return "error"
    if state.paused:
        return "paused"
    if state.running:
        if live_error or (
            not state.live.doctor.ok and not is_bullpen_login_required(signal_text)
        ):
            return "error"
        return "running"
    if (
        variant == "direct"
        and not state.started_at
        and not state.tracked_accounts
        and is_direct_execution_not_configured(signal_text)
    ):
        return "not-configured"
    return "stopped"


def build_guardrails_summary(guardrails: list[TradingBotGuardrail]) -> str:
    return " • ".join(
        f"{guardrail.label}: {guardrail.value}" for guardrail in guardrails[:4]
    )


def build_polymarket_card(
    state: BullpenPolymarketState | DirectPolymarketState,
    *,
    bot_id: str,
) -> TradingBotCardSummary:
    is_bullpen_variant = bot_id == "bullpen-x-polymarket"
    route = "/console/polymarket-bot" if is_bullpen_variant else "/console/polymarket-direct-bot"
    invested = round_money(
        sum(position.cost_basis or 0 for position in state.open_positions)
    )
    current_value = state.live.balance.account_value_usd
    if current_value is None and state.metrics.total_pnl is not None and invested is not None:
        current_value = round_money(invested + state.metrics.total_pnl)
    profit_loss = (
        round_money(state.metrics.total_pnl)
        if state.metrics.total_pnl is not None
        else round_money((current_value or 0) - (invested or 0))
        if current_value is not None and invested is not None
        else None
    )
    return_pct = None
    if invested and invested > 0 and profit_loss is not None:
        return_pct = round((profit_loss / invested) * 100, 2)

    if is_bullpen_variant:
        guardrails = [
            TradingBotGuardrail(
                label="Fixed copy size",
                value=format_money(state.config.fixed_copy_trade_size),
            ),
            TradingBotGuardrail(
                label="Max live trade",
                value=format_money(state.live.max_live_trade_size),
            ),
            TradingBotGuardrail(
                label="Max market exposure",
                value=format_money(state.config.max_live_exposure_per_market),
            ),
            TradingBotGuardrail(
                label="Daily live loss stop",
                value=format_money(state.config.max_live_daily_loss),
                tone="warning",
            ),
            TradingBotGuardrail(
                label="Pending confirmations",
                value=format_integer(len(state.live.pending_confirmations)),
            ),
            TradingBotGuardrail(
                label="Emergency stop",
                value="Active" if state.live.emergency_stopped else "Clear",
                tone="critical" if state.live.emergency_stopped else "positive",
            ),
        ]
        name = "Bullpen x Polymarket"
        strategy = (
            "Copies eligible Bullpen trader activity into Polymarket positions after live-read filters, exposure checks, and execution guardrails pass."
        )
        risk = (
            "Copied trades can arrive late, liquidity can disappear fast, and session issues can delay exits."
        )
        variant = "bullpen"
    else:
        guardrails = [
            TradingBotGuardrail(
                label="Max live trade",
                value=format_money(state.live.max_live_trade_size),
            ),
            TradingBotGuardrail(
                label="Max live trades/day",
                value=format_integer(state.config.max_live_trades_per_day),
            ),
            TradingBotGuardrail(
                label="Max market exposure",
                value=format_money(state.config.max_live_exposure_per_market),
            ),
            TradingBotGuardrail(
                label="Daily live loss stop",
                value=format_money(state.config.max_live_daily_loss),
                tone="warning",
            ),
            TradingBotGuardrail(
                label="Manual confirmation",
                value="Required" if state.config.require_manual_confirmation else "Auto",
            ),
            TradingBotGuardrail(
                label="Emergency stop",
                value="Active" if state.live.emergency_stopped else "Clear",
                tone="critical" if state.live.emergency_stopped else "positive",
            ),
        ]
        name = "Polymarket Direct"
        strategy = (
            "Mirrors configured trader activity through the direct execution workflow with live-read discovery, live controls, and execution checks."
        )
        risk = (
            "Direct execution depends on account readiness, liquidity, and correct market mapping under live conditions."
        )
        variant = "direct"

    note = (
        state.last_error
        or state.live.source_status.last_live_read_error
        or (None if state.live.doctor.ok else state.live.doctor.message)
    )

    return TradingBotCardSummary(
        id=bot_id,
        name=name,
        route=route,
        status=get_polymarket_status(state, variant=variant),
        mode=map_polymarket_mode(state.mode),
        invested_usd=invested,
        current_value_usd=round_money(current_value),
        pnl_usd=profit_loss,
        return_pct=return_pct,
        active_positions=sum(1 for position in state.open_positions if position.shares > 0),
        trades_today=count_polymarket_trades_today(state),
        last_run_at=state.last_poll_at or state.started_at or state.session_started_at,
        next_run_at=state.next_poll_at if state.running else None,
        guardrails_summary=build_guardrails_summary(guardrails),
        strategy_summary=strategy,
        risk_summary=risk,
        guardrails=guardrails,
        note=note,
        source="api",
    )


def build_bullpen_ai_placeholder_card() -> TradingBotCardSummary:
    guardrails = [
        TradingBotGuardrail(label="Selection filters", value="Active market filters"),
        TradingBotGuardrail(label="Evidence check", value="Consensus review required"),
        TradingBotGuardrail(
            label="Pink-row threshold",
            value="LLM Yes or No > 80% with returns/day available",
        ),
        TradingBotGuardrail(label="Sizing logic", value="Amount-to-invest formula"),
        TradingBotGuardrail(label="Execution", value="Manual review before live invest"),
    ]
    return TradingBotCardSummary(
        id="bullpen-x-ai",
        name="Bullpen x AI",
        route="/console/bullpen-ai",
        status="stopped",
        mode="analysis-only",
        invested_usd=None,
        current_value_usd=None,
        pnl_usd=None,
        return_pct=None,
        active_positions=None,
        trades_today=None,
        last_run_at=None,
        next_run_at=None,
        guardrails_summary=build_guardrails_summary(guardrails),
        strategy_summary=(
            "Runs Bullpen scans, applies market filters, evaluates evidence, and produces LLM consensus before optional manual trading actions."
        ),
        risk_summary=(
            "Model drift, stale market rules, and manual execution lag can all distort edge estimates."
        ),
        guardrails=guardrails,
        note="Live metrics are not yet exposed for Bullpen x AI, so this card is using safe placeholders.",
        source="placeholder",
    )


def build_auto_live_card_from_summary(summary) -> TradingBotCardSummary:
    bot_card = summary.bot_card
    return TradingBotCardSummary(
        id=bot_card.id,
        name=bot_card.name,
        route=bot_card.route,
        status=bot_card.status,
        mode=bot_card.mode,
        invested_usd=bot_card.invested_usd,
        current_value_usd=bot_card.current_value_usd,
        pnl_usd=bot_card.pnl_usd,
        return_pct=bot_card.return_pct,
        active_positions=bot_card.active_positions,
        trades_today=bot_card.trades_today,
        last_run_at=bot_card.last_run_at,
        next_run_at=bot_card.next_run_at,
        guardrails_summary=bot_card.guardrails_summary,
        strategy_summary=AUTO_LIVE_STRATEGY_SUMMARY,
        risk_summary=AUTO_LIVE_RISK_SUMMARY,
        guardrails=[
            TradingBotGuardrail(
                label=guardrail.label,
                value=guardrail.value,
                tone=guardrail.tone,
            )
            for guardrail in bot_card.guardrails
        ],
        note=summary.state.last_action,
        source="api",
    )


def to_overview_card(card: TradingBotCardSummary) -> TradingBotOverviewCard:
    return TradingBotOverviewCard(
        id=card.id,
        name=card.name,
        href=card.route,
        details_href=card.route,
        status=card.status,
        mode=card.mode,
        money_invested=card.invested_usd,
        current_value=card.current_value_usd,
        profit_loss=card.pnl_usd,
        return_pct=card.return_pct,
        active_positions_count=card.active_positions,
        trades_today=card.trades_today,
        last_run_time=card.last_run_at,
        next_scheduled_run=card.next_run_at,
        guardrails_summary=card.guardrails_summary,
        guardrails=card.guardrails,
        strategy=card.strategy_summary,
        risk_warning=card.risk_summary,
        note=card.note,
        source=card.source,
    )


async def build_trading_bots_summary(user_id: int) -> TradingBotsSummaryResponse:
    cards: list[TradingBotCardSummary] = []

    try:
        bullpen_bot = await polymarket_bot_manager.get_bot(user_id)
        cards.append(
            build_polymarket_card(
                await bullpen_bot.get_state(),
                bot_id="bullpen-x-polymarket",
            )
        )
    except Exception as exc:
        cards.append(
            TradingBotCardSummary(
                id="bullpen-x-polymarket",
                name="Bullpen x Polymarket",
                route="/console/polymarket-bot",
                status="error",
                mode="paper",
                guardrails_summary="Unable to load guardrails right now.",
                strategy_summary=(
                    "Copies eligible Bullpen trader activity into Polymarket positions after live-read filters, exposure checks, and execution guardrails pass."
                ),
                risk_summary=(
                    "Copied trades can arrive late, liquidity can disappear fast, and session issues can delay exits."
                ),
                note=str(exc),
                source="fallback",
            )
        )

    try:
        direct_bot = await polymarket_direct_bot_manager.get_bot(user_id)
        cards.append(
            build_polymarket_card(
                await direct_bot.get_state(),
                bot_id="polymarket-direct",
            )
        )
    except Exception as exc:
        cards.append(
            TradingBotCardSummary(
                id="polymarket-direct",
                name="Polymarket Direct",
                route="/console/polymarket-direct-bot",
                status="error",
                mode="paper",
                guardrails_summary="Unable to load guardrails right now.",
                strategy_summary=(
                    "Mirrors configured trader activity through the direct execution workflow with live-read discovery, live controls, and execution checks."
                ),
                risk_summary=(
                    "Direct execution depends on account readiness, liquidity, and correct market mapping under live conditions."
                ),
                note=str(exc),
                source="fallback",
            )
        )

    cards.append(build_bullpen_ai_placeholder_card())

    try:
        auto_live_bot = await polymarket_auto_live_bot_manager.get_bot(user_id)
        cards.append(build_auto_live_card_from_summary(await auto_live_bot.get_summary()))
    except Exception as exc:
        cards.append(
            TradingBotCardSummary(
                id="bullpen-ai-auto-live",
                name="Bullpen AI Auto-Live",
                route="/console/trading-bots/bullpen-ai-auto-live",
                status="error",
                mode="dry-run",
                guardrails_summary=(
                    "Sizing, exposure, evidence, disagreement, and loss-stop guardrails are scaffolded and waiting for live config."
                ),
                strategy_summary=AUTO_LIVE_STRATEGY_SUMMARY,
                risk_summary=AUTO_LIVE_RISK_SUMMARY,
                note=str(exc),
                source="fallback",
            )
        )

    order = {
        "bullpen-x-polymarket": 0,
        "polymarket-direct": 1,
        "bullpen-x-ai": 2,
        "bullpen-ai-auto-live": 3,
    }
    cards.sort(key=lambda card: order[card.id])
    return TradingBotsSummaryResponse(generated_at=utc_now(), cards=cards)


async def build_trading_bots_overview(user_id: int) -> TradingBotsOverviewResponse:
    summary = await build_trading_bots_summary(user_id)
    return TradingBotsOverviewResponse(
        generated_at=summary.generated_at,
        bots=[to_overview_card(card) for card in summary.cards],
    )
