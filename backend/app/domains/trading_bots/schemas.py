from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

TradingBotSummaryId = Literal[
    "bullpen-x-polymarket",
    "polymarket-direct",
    "bullpen-x-ai",
    "bullpen-ai-auto-live",
]
TradingBotStatus = Literal["running", "paused", "stopped", "error", "not-configured"]
TradingBotMode = Literal[
    "paper",
    "live-read",
    "live-trading",
    "dry-run",
    "analysis-only",
]
TradingBotGuardrailTone = Literal["neutral", "positive", "warning", "critical"]


class TradingBotGuardrail(BaseModel):
    label: str
    value: str
    tone: TradingBotGuardrailTone = "neutral"


class TradingBotCardSummary(BaseModel):
    id: TradingBotSummaryId
    name: str
    route: str
    status: TradingBotStatus
    mode: TradingBotMode
    invested_usd: float | None = None
    current_value_usd: float | None = None
    pnl_usd: float | None = None
    return_pct: float | None = None
    active_positions: int | None = None
    trades_today: int | None = None
    last_run_at: str | None = None
    next_run_at: str | None = None
    guardrails_summary: str
    strategy_summary: str
    risk_summary: str
    guardrails: list[TradingBotGuardrail] = Field(default_factory=list)
    note: str | None = None
    source: Literal["api", "fallback", "placeholder"] = "api"


class TradingBotsSummaryResponse(BaseModel):
    generated_at: str
    cards: list[TradingBotCardSummary] = Field(default_factory=list)


class TradingBotOverviewCard(BaseModel):
    id: TradingBotSummaryId
    name: str
    href: str
    details_href: str | None = None
    status: TradingBotStatus
    mode: TradingBotMode
    money_invested: float | None = None
    current_value: float | None = None
    profit_loss: float | None = None
    return_pct: float | None = None
    active_positions_count: int | None = None
    trades_today: int | None = None
    last_run_time: str | None = None
    next_scheduled_run: str | None = None
    guardrails_summary: str
    guardrails: list[TradingBotGuardrail] = Field(default_factory=list)
    strategy: str
    risk_warning: str
    note: str | None = None
    source: Literal["api", "fallback", "placeholder"] = "api"


class TradingBotsOverviewResponse(BaseModel):
    generated_at: str
    bots: list[TradingBotOverviewCard] = Field(default_factory=list)
