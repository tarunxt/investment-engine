from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

from app.domains.polymarket.bullpen import (
    run_bullpen_json,
    run_first_bullpen_json,
    utc_now,
)
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.schemas import (
    PolymarketBotConfig,
    PolymarketDiscoveryDebugAccepted,
    PolymarketDiscoveryDebugCandidate,
    PolymarketDiscoveryDebugCommand,
    PolymarketDiscoveryDebugError,
    PolymarketDiscoveryDebugRejected,
    PolymarketDiscoveryDebugReport,
    PolymarketLiveSourceStatus,
    PolymarketSourceTrade,
    PolymarketTrader,
    TradeSource,
)

POLYMARKET_DATA_API_BASE_URL = "https://data-api.polymarket.com"
POLYMARKET_DATA_API_TIMEOUT_SECONDS = 10

MOCK_MARKETS: list[tuple[str, str, str]] = [
    ("btc-100k-2026", "Will Bitcoin hit $100k in 2026?", "Yes"),
    ("fed-cut-june", "Will the Fed cut rates by June?", "Yes"),
    ("eth-ath-2026", "Will ETH hit a new all-time high in 2026?", "No"),
    ("election-turnout", "Will US turnout exceed 155M?", "Yes"),
    ("nba-finals", "Will Boston win the championship?", "No"),
]


class MarketDataProvider(Protocol):
    async def get_top_traders(self) -> list[PolymarketTrader]: ...

    async def get_recent_trades(
        self, traders: list[PolymarketTrader]
    ) -> list[PolymarketSourceTrade]: ...


class MockProvider:
    def __init__(self) -> None:
        self._counter = 0

    async def get_top_traders(self) -> list[PolymarketTrader]:
        return [
            PolymarketTrader(
                id=f"mock-trader-{index + 1}",
                name=f"Mock Trader {index + 1}",
                address=f"0xMOCK{str(index + 1).rjust(36, '0')}",
                activity_source="fallback",
                volume_24h=50_000 - index * 2_750,
                trades_24h=120 - index * 8,
                source_reason="Mock trader",
                source="mock",
            )
            for index in range(10)
        ]

    async def get_recent_trades(
        self, traders: list[PolymarketTrader]
    ) -> list[PolymarketSourceTrade]:
        self._counter += 1
        batch_size = 6 if self._counter == 1 else 1 + (self._counter % 3)
        rows: list[PolymarketSourceTrade] = []
        for index in range(batch_size):
            trader = traders[(self._counter + index) % len(traders)]
            market = MOCK_MARKETS[(self._counter + index) % len(MOCK_MARKETS)]
            side = "BUY" if (self._counter + index) % 3 else "SELL"
            price = round(0.25 + (((self._counter + index) * 7) % 50) / 100, 2)
            size_usd = round(10 + (((self._counter + index) * 13) % 90), 2)
            rows.append(
                PolymarketSourceTrade(
                    id=f"mock-{self._counter}-{index}-{side}-{market[0]}",
                    source_trade_key=(
                        f"mock:{trader.id}:{market[0]}:{market[2]}:{side}:{self._counter}:{size_usd:.6f}:{price:.4f}"
                    ),
                    trader_id=trader.id,
                    trader_name=trader.name,
                    trader_address=trader.address,
                    clean_trader_identity=trader.address,
                    market_id=market[0],
                    market_title=market[1],
                    outcome=market[2],
                    side=side,
                    price=price,
                    size_usd=size_usd,
                    timestamp=utc_now(),
                    source="mock",
                )
            )
        return rows


class BullpenReadOnlyProvider:
    def __init__(self, config: PolymarketBotConfig) -> None:
        self.config = config
        parsed_wallets = parse_manual_wallets(config.manual_tracked_wallets)
        self.manual_wallets = parsed_wallets["valid"]
        self.invalid_manual_wallets = parsed_wallets["invalid"]
        self.last_discovery_status = self._empty_status()

    def update_manual_targets(self, targets: str) -> None:
        parsed_wallets = parse_manual_wallets(targets)
        self.manual_wallets = parsed_wallets["valid"]
        self.invalid_manual_wallets = parsed_wallets["invalid"]
        self.last_discovery_status = self._empty_status()

    async def get_top_traders(self) -> list[PolymarketTrader]:
        discovery = await self._discover_active_traders()
        manual = await self._read_manual_wallets()
        leaderboard = await self._read_weekly_leaderboard_traders()
        fallback = (
            {
                "traders": [],
                "rows_considered": 0,
                "wallets_extracted": 0,
                "rows_rejected": 0,
            }
            if leaderboard["traders"] or discovery["active"]
            else await self._read_fallback_wallets()
        )
        merged = merge_traders(
            [
                *leaderboard["traders"],
                *discovery["active"],
                *fallback["traders"],
                *manual,
            ]
        )
        selected = select_tracked_traders(
            merged, manual, self.config.max_tracked_traders
        )
        self.last_discovery_status = PolymarketLiveSourceStatus(
            source_mode="live-read",
            discovery_mode=(
                "weekly P&L leaderboard + active feed + manual wallets + optional trending market activity"
                if self.config.use_trending_market_activity
                else "weekly P&L leaderboard + active feed + manual wallets"
            ),
            active_traders_found=len(leaderboard["traders"]) + len(discovery["active"]),
            candidate_rows_considered=leaderboard["rows_considered"]
            + discovery["candidate_rows_considered"]
            + fallback["rows_considered"],
            candidate_wallets_extracted=leaderboard["wallets_extracted"]
            + discovery["candidate_wallets_extracted"]
            + fallback["wallets_extracted"],
            fallback_traders_selected=len(fallback["traders"]),
            activity_source_used=(
                "wallet"
                if leaderboard["traders"]
                else (
                    "feed"
                    if discovery["active"]
                    else ("fallback" if fallback["traders"] else None)
                )
            ),
            rows_rejected_last_discovery=leaderboard["rows_rejected"]
            + discovery["rows_rejected"]
            + fallback["rows_rejected"],
            accepted_activity_trades_last_discovery=discovery["accepted_trades"],
            manual_wallets_configured=len(self.manual_wallets)
            + len(self.invalid_manual_wallets),
            manual_wallets_valid=len(self.manual_wallets),
            manual_wallets_invalid=[
                redact_manual_wallet_input(item) for item in self.invalid_manual_wallets
            ],
            manual_tracked_wallets=manual,
            last_active_trader_discovery_time=utc_now(),
            last_discovery_error=leaderboard["error"] or discovery["error"],
            trending_market_activity_enabled=self.config.use_trending_market_activity,
            trending_market_activity_unavailable=(
                None
                if self.config.use_trending_market_activity
                else "Trending market activity disabled"
            ),
        )
        return selected

    async def get_recent_trades(
        self, traders: list[PolymarketTrader]
    ) -> list[PolymarketSourceTrade]:
        manual = [trader for trader in traders if "Manual" in trader.source_reason]
        selected = select_tracked_traders(
            traders, manual, self.config.max_tracked_traders
        )
        live_read_trades = await self._read_tracked_wallet_trades(selected)
        market_trades = (
            await self._read_trending_market_trades()
            if self.config.use_trending_market_activity
            else []
        )
        return dedupe_trades([*live_read_trades, *market_trades])[:100]

    def get_discovery_status(self) -> PolymarketLiveSourceStatus:
        return self.last_discovery_status

    async def debug_discovery(
        self, target: str = "swisstony"
    ) -> PolymarketDiscoveryDebugReport:
        return await debug_discovery(target)

    async def _read_weekly_leaderboard_traders(self) -> dict[str, Any]:
        try:
            parsed = await run_first_bullpen_json(
                [
                    [
                        "polymarket",
                        "data",
                        "leaderboard",
                        "--time-period",
                        "7d",
                        "--sort",
                        "pnl",
                        "--hide-farmers",
                        "--hide-bots",
                        "--limit",
                        "25",
                        "--read-only",
                        "--non-interactive",
                        "--output",
                        "json",
                    ],
                    [
                        "polymarket",
                        "data",
                        "leaderboard",
                        "--period",
                        "week",
                        "--sort",
                        "pnl",
                        "--limit",
                        "25",
                        "--read-only",
                        "--non-interactive",
                        "--output",
                        "json",
                    ],
                ]
            )
            rows = collect_rows(parsed)
            normalized = [normalize_fallback_trader_row(row) for row in rows]
            traders = [trader for trader in normalized if trader]
            active = [
                trader
                for trader in traders
                if trader.volume_24h > 0
                or trader.trades_24h > 0
                or trader.last_trade_at
            ]
            selected = active or traders
            for trader in selected:
                trader.source_reason = (
                    "Weekly P&L leaderboard trader discovered via Bullpen"
                )
            return {
                "traders": selected[:25],
                "rows_considered": len(rows),
                "wallets_extracted": len(
                    {trader.address.lower() for trader in selected if trader.address}
                ),
                "rows_rejected": len(rows) - len(traders),
                "error": None,
            }
        except Exception as exc:
            return {
                "traders": [],
                "rows_considered": 0,
                "wallets_extracted": 0,
                "rows_rejected": 0,
                "error": f"Weekly leaderboard unavailable: {redact_secrets(str(exc))}",
            }

    async def _discover_active_traders(self) -> dict[str, Any]:
        try:
            parsed = await run_bullpen_json(
                [
                    "polymarket",
                    "feed",
                    "trades",
                    "--read-only",
                    "--non-interactive",
                    "--limit",
                    "1000",
                    "--output",
                    "json",
                ]
            )
            rows = collect_rows(parsed)
            normalized = [normalize_trade_row(row) for row in rows]
            trades = [item["trade"] for item in normalized if item["accepted"]]
            active = [
                trader
                for trader in aggregate_traders(
                    trades,
                    "live-read",
                    "Active trader discovered from recent Bullpen trade feed",
                )
                if trader.trades_24h > 0
            ]
            return {
                "active": active,
                "candidate_rows_considered": len(rows),
                "candidate_wallets_extracted": len(
                    {
                        trade.get("address", "").lower()
                        for trade in trades
                        if isinstance(trade.get("address"), str) and trade["address"]
                    }
                ),
                "rows_rejected": len(
                    [item for item in normalized if not item["accepted"]]
                ),
                "accepted_trades": len(trades),
                "error": None,
            }
        except Exception as exc:
            return {
                "active": [],
                "candidate_rows_considered": 0,
                "candidate_wallets_extracted": 0,
                "rows_rejected": 0,
                "accepted_trades": 0,
                "error": f"Active trader discovery unavailable: {redact_secrets(str(exc))}",
            }

    async def _read_fallback_wallets(self) -> dict[str, Any]:
        try:
            parsed = await run_bullpen_json(
                [
                    "polymarket",
                    "data",
                    "leaderboard",
                    "--read-only",
                    "--non-interactive",
                    "--limit",
                    "25",
                    "--output",
                    "json",
                ]
            )
            rows = collect_rows(parsed)
            traders = [
                item
                for item in (normalize_fallback_trader_row(row) for row in rows)
                if item
            ][:10]
            return {
                "traders": traders,
                "rows_considered": len(rows),
                "wallets_extracted": len(
                    {trader.address.lower() for trader in traders if trader.address}
                ),
                "rows_rejected": len(rows) - len(traders),
            }
        except Exception:
            return {
                "traders": [],
                "rows_considered": 0,
                "wallets_extracted": 0,
                "rows_rejected": 0,
            }

    async def _read_manual_wallets(self) -> list[PolymarketTrader]:
        traders: list[PolymarketTrader] = []
        for target in self.manual_wallets:
            is_wallet = is_public_wallet_address(target)
            handle = None if is_wallet else clean_handle(target)
            try:
                seed = PolymarketTrader(
                    id=target,
                    name=short_address(target) if is_wallet else f"@{handle or target}",
                    address=target if is_wallet else "",
                    handle=handle,
                    profile_slug=handle,
                    activity_source="wallet" if is_wallet else "handle",
                    polymarket_profile_url=(
                        polymarket_profile_url(target)
                        if is_wallet
                        else polymarket_handle_profile_url(handle)
                    ),
                    profile_url=polymarket_handle_profile_url(handle),
                    activity_url=polymarket_handle_activity_url(handle),
                    volume_24h=0,
                    trades_24h=0,
                    source_reason="Manual tracked account",
                    source="live-read",
                )
                trades = (
                    await self._read_wallet_activity(target)
                    if is_wallet
                    else await self._read_handle_or_feed_activity(seed)
                )
                aggregated = aggregate_traders(
                    trades, "live-read", "Manual tracked account"
                )
                if aggregated:
                    trader = aggregated[0]
                    trader.handle = trader.handle or handle
                    trader.profile_slug = trader.profile_slug or handle
                    trader.profile_url = (
                        trader.profile_url or polymarket_handle_profile_url(handle)
                    )
                    trader.activity_url = (
                        trader.activity_url or polymarket_handle_activity_url(handle)
                    )
                    trader.polymarket_profile_url = (
                        trader.polymarket_profile_url or seed.polymarket_profile_url
                    )
                    traders.append(trader)
                else:
                    traders.append(seed)
            except Exception:
                traders.append(
                    PolymarketTrader(
                        id=target,
                        name=(
                            short_address(target)
                            if is_wallet
                            else f"@{handle or target}"
                        ),
                        address=target if is_wallet else "",
                        handle=handle,
                        profile_slug=handle,
                        activity_source="wallet" if is_wallet else "handle",
                        profile_url=polymarket_handle_profile_url(handle),
                        activity_url=polymarket_handle_activity_url(handle),
                        polymarket_profile_url=(
                            polymarket_profile_url(target)
                            if is_wallet
                            else polymarket_handle_profile_url(handle)
                        ),
                        volume_24h=0,
                        trades_24h=0,
                        source_reason="Manual tracked account; recent activity unavailable",
                        source="live-read",
                    )
                )
        return traders

    async def _read_tracked_wallet_trades(
        self, traders: list[PolymarketTrader]
    ) -> list[PolymarketSourceTrade]:
        rows: list[PolymarketSourceTrade] = []
        for trader in [item for item in traders if item.source == "live-read"]:
            try:
                wallet_trades = (
                    await self._read_wallet_activity(trader.address)
                    if is_public_wallet_address(trader.address)
                    else []
                )
                trades = wallet_trades or await self._read_handle_or_feed_activity(
                    trader
                )
                if wallet_trades:
                    trader.activity_source = "wallet"
                elif trades:
                    trader.activity_source = "handle"
                rows.extend(
                    source_trade_from_normalized(trade, trader, "live-read", index)
                    for index, trade in enumerate(trades)
                )
            except Exception:
                continue
        return [trade for trade in rows if trade.source == "live-read"]

    async def _read_wallet_activity(self, address: str) -> list[dict[str, Any]]:
        bullpen_error: Exception | None = None
        bullpen_trades: list[dict[str, Any]] = []
        try:
            parsed = await run_first_bullpen_json(
                [
                    [
                        "polymarket",
                        "data",
                        "profile",
                        address,
                        "--trades",
                        "--read-only",
                        "--non-interactive",
                        "--output",
                        "json",
                    ],
                    [
                        "polymarket",
                        "activity",
                        "--address",
                        address,
                        "--type",
                        "trade",
                        "--limit",
                        "50",
                        "--read-only",
                        "--non-interactive",
                        "--output",
                        "json",
                    ],
                ]
            )
            bullpen_trades = normalize_trade_rows_for_wallet(parsed, address)
        except Exception as exc:
            bullpen_error = exc

        try:
            data_api_trades = await self._read_data_api_wallet_activity(address)
            return dedupe_normalized_trade_rows([*data_api_trades, *bullpen_trades])
        except Exception as exc:
            if bullpen_trades:
                return bullpen_trades
            if bullpen_error:
                raise bullpen_error from exc
            raise

    async def _read_data_api_wallet_activity(
        self, address: str
    ) -> list[dict[str, Any]]:
        query = urlencode(
            {
                "user": address,
                "type": "TRADE",
                "limit": "100",
                "sortBy": "TIMESTAMP",
                "sortDirection": "DESC",
            }
        )
        url = f"{POLYMARKET_DATA_API_BASE_URL}/activity?{query}"
        async with httpx.AsyncClient(
            timeout=POLYMARKET_DATA_API_TIMEOUT_SECONDS,
            headers={"User-Agent": "investment-engine-polymarket-bot/1.0"},
        ) as client:
            response = await client.get(url)
            response.raise_for_status()
            return normalize_trade_rows_for_wallet(response.json(), address)

    async def _read_handle_or_feed_activity(
        self, trader: PolymarketTrader
    ) -> list[dict[str, Any]]:
        parsed = await run_bullpen_json(
            [
                "polymarket",
                "feed",
                "trades",
                "--read-only",
                "--non-interactive",
                "--limit",
                "1000",
                "--output",
                "json",
            ]
        )
        identities = trader_identity_candidates(trader)
        normalized = [normalize_trade_row(row) for row in collect_rows(parsed)]
        return [
            item["trade"]
            for item in normalized
            if item["accepted"]
            and identity_key(
                item["trade"].get("address")
                or item["trade"].get("handle")
                or item["trade"].get("trader_name")
                or ""
            )
            in identities
        ]

    async def _read_trending_market_trades(self) -> list[PolymarketSourceTrade]:
        try:
            markets = await run_bullpen_json(
                [
                    "polymarket",
                    "markets",
                    "--active",
                    "--sort",
                    "volume24h",
                    "--limit",
                    "5",
                    "--read-only",
                    "--non-interactive",
                    "--output",
                    "json",
                ]
            )
            market_rows = collect_rows(markets)
            trades: list[PolymarketSourceTrade] = []
            for market in market_rows:
                slug = string_value(
                    market.get("slug") or market.get("marketSlug") or market.get("id")
                )
                if not slug:
                    continue
                parsed = await run_bullpen_json(
                    [
                        "polymarket",
                        "trades",
                        slug,
                        "--limit",
                        "25",
                        "--read-only",
                        "--non-interactive",
                        "--output",
                        "json",
                    ]
                )
                rows = collect_rows(parsed)
                for index, row in enumerate(rows):
                    normalized = normalize_trade_row(
                        {
                            **row,
                            "slug": slug,
                            "marketTitle": row.get("marketTitle")
                            or row.get("title")
                            or market.get("title")
                            or market.get("question")
                            or slug,
                        }
                    )
                    if normalized["accepted"]:
                        trades.append(
                            source_trade_from_normalized(
                                normalized["trade"], None, "live-market-read", index
                            )
                        )
            self.last_discovery_status.trending_market_activity_unavailable = None
            return trades
        except Exception as exc:
            self.last_discovery_status.trending_market_activity_unavailable = (
                "Trending market activity unavailable: read-only Bullpen command not found. "
                f"{redact_secrets(str(exc))}"
            )
            return []

    def _empty_status(self) -> PolymarketLiveSourceStatus:
        return PolymarketLiveSourceStatus(
            source_mode="live-read",
            discovery_mode=(
                "active feed + manual wallets + optional trending market activity"
                if self.config.use_trending_market_activity
                else "active feed + manual wallets"
            ),
            manual_wallets_configured=len(self.manual_wallets)
            + len(self.invalid_manual_wallets),
            manual_wallets_valid=len(self.manual_wallets),
            manual_wallets_invalid=[
                redact_manual_wallet_input(item) for item in self.invalid_manual_wallets
            ],
            manual_tracked_wallets=[],
            trending_market_activity_enabled=self.config.use_trending_market_activity,
            trending_market_activity_unavailable=(
                None
                if self.config.use_trending_market_activity
                else "Trending market activity disabled"
            ),
        )


def aggregate_traders(
    trades: list[dict[str, Any]], source: TradeSource, source_reason: str
) -> list[PolymarketTrader]:
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    aggregated: dict[str, PolymarketTrader] = {}
    for trade in trades:
        identity = clean_trade_identity(trade)
        if not identity:
            continue
        key = identity_key(identity)
        address = trade.get("address") or ""
        handle = trade.get("handle") or handle_from_name(trade.get("trader_name"))
        trader = aggregated.get(
            key,
            PolymarketTrader(
                id=identity,
                name=trade.get("trader_name")
                or handle
                or (short_address(address) if address else identity),
                address=address,
                handle=handle,
                profile_slug=handle,
                profile_url=(
                    polymarket_handle_profile_url(handle)
                    if handle
                    else polymarket_profile_url(address)
                ),
                activity_url=(
                    polymarket_handle_activity_url(handle)
                    if handle
                    else polymarket_profile_url(address)
                ),
                activity_source="feed",
                polymarket_profile_url=(
                    polymarket_handle_profile_url(handle)
                    if handle
                    else polymarket_profile_url(address)
                ),
                volume_24h=0,
                trades_1h=0,
                trades_6h=0,
                trades_24h=0,
                source_reason=source_reason,
                source=source,
            ),
        )
        age_ms = now_ms - datetime.fromisoformat(trade["timestamp"]).timestamp() * 1000
        if 0 <= age_ms <= 60 * 60 * 1000:
            trader.trades_1h += 1
        if 0 <= age_ms <= 6 * 60 * 60 * 1000:
            trader.trades_6h += 1
        if 0 <= age_ms <= 24 * 60 * 60 * 1000:
            trader.trades_24h += 1
            trader.volume_24h += float(trade["size_usd"])
        if not trader.last_trade_at or datetime.fromisoformat(
            trade["timestamp"]
        ) > datetime.fromisoformat(trader.last_trade_at):
            trader.last_trade_at = trade["timestamp"]
            trader.last_trade_age = age_label(age_ms)
        aggregated[key] = trader
    return list(aggregated.values())


def source_trade_from_normalized(
    trade: dict[str, Any],
    trader: PolymarketTrader | None,
    source: TradeSource,
    index: int,
) -> PolymarketSourceTrade:
    identity = clean_trade_identity(trade, trader) or "unknown"
    raw_identity = (
        trade.get("raw_identity")
        or (trader.id if trader else None)
        or trade.get("trader_name")
        or trade.get("handle")
        or trade.get("address")
        or identity
    )
    stable_key = stable_trade_key(source, identity, trade)
    fallback_trade_id = f"{trade['market_id']}:{identity}:{trade['timestamp']}:{index}"
    return PolymarketSourceTrade(
        id=stable_key or f"{source}:{trade.get('id') or fallback_trade_id}",
        source_trade_key=stable_key
        or f"{source}:{identity_key(identity)}:{identity_key(trade['market_id'])}:{identity_key(trade['outcome'])}:{trade['side']}:{trade['timestamp']}:{trade['size_usd']:.6f}:{trade['price']:.4f}",
        trader_id=trader.id if trader else identity,
        trader_name=(
            trader.name
            if trader
            else trade.get("trader_name")
            or trade.get("handle")
            or (
                short_address(identity)
                if is_public_wallet_address(identity)
                else identity
            )
        ),
        trader_address=trade.get("address") or (trader.address if trader else ""),
        trader_handle=(trader.handle if trader else None) or trade.get("handle"),
        source_trade_id=trade.get("id"),
        raw_trader_identity=raw_identity,
        clean_trader_identity=identity,
        market_id=trade["market_id"],
        market_title=trade["market_title"],
        outcome=trade["outcome"],
        side=trade["side"],
        price=float(trade["price"]),
        size_usd=float(trade["size_usd"]),
        timestamp=trade["timestamp"],
        source=source,
    )


def normalize_fallback_trader_row(row: dict[str, Any]) -> PolymarketTrader | None:
    address = extract_address(row)
    handle = extract_handle(row)
    if not address and not handle:
        return None
    volume_24h = (
        number_value(
            row.get("volume24h")
            or row.get("volume_24h")
            or row.get("volume")
            or row.get("totalVolume")
            or row.get("weeklyVolume")
        )
        or 0
    )
    trades_24h = int(
        number_value(
            row.get("trades24h")
            or row.get("trades_24h")
            or row.get("trades")
            or row.get("tradeCount")
        )
        or 0
    )
    name = string_value(
        row.get("name")
        or row.get("username")
        or row.get("user_name")
        or row.get("displayName")
        or row.get("traderName")
        or row.get("pseudonym")
        or handle
    )
    return PolymarketTrader(
        id=address or handle or "",
        name=name or (short_address(address) if address else (handle or "")),
        address=address or "",
        handle=handle,
        profile_slug=handle,
        profile_url=(
            polymarket_handle_profile_url(handle)
            if handle
            else polymarket_profile_url(address or "")
        ),
        activity_url=(
            polymarket_handle_activity_url(handle)
            if handle
            else polymarket_profile_url(address or "")
        ),
        activity_source="fallback",
        bullpen_profile_url=safe_http_url(
            row.get("bullpenProfileUrl") or row.get("profileUrl") or row.get("url")
        ),
        polymarket_profile_url=(
            polymarket_handle_profile_url(handle)
            if handle
            else polymarket_profile_url(address or "")
        ),
        volume_24h=volume_24h,
        trades_24h=trades_24h,
        last_trade_at=parse_timestamp(
            row.get("lastTradeAt")
            or row.get("last_trade_at")
            or row.get("lastActiveAt")
            or row.get("updatedAt")
        ),
        source_reason="Fallback tracked wallet; no recent trade detected yet",
        source="live-read",
    )


def normalize_trade_row(row: dict[str, Any]) -> dict[str, Any]:
    address = extract_address(row)
    handle = extract_handle(row)
    trader_name = string_value(
        row.get("name")
        or row.get("username")
        or row.get("user_name")
        or row.get("traderName")
        or row.get("trader_name")
        or row.get("pseudonym")
    )
    raw_identity = raw_identity_value(row)
    timestamp = parse_timestamp(
        row.get("timestamp")
        or row.get("createdAt")
        or row.get("created_at")
        or row.get("time")
        or row.get("date")
        or row.get("executedAt")
        or row.get("executed_at")
        or row.get("updatedAt")
        or row.get("updated_at")
    )
    market_id = string_value(
        row.get("slug")
        or row.get("marketSlug")
        or row.get("market_slug")
        or row.get("market_id")
        or row.get("marketId")
        or row.get("conditionId")
        or row.get("condition_id")
    )
    sample_keys = list(row.keys())[:40]
    side = (
        "SELL"
        if "sell"
        in str(row.get("side") or row.get("action") or row.get("type") or "").lower()
        else "BUY"
    )
    row_type = string_value(
        row.get("type")
        or row.get("activityType")
        or row.get("activity_type")
        or row.get("eventType")
        or row.get("event_type")
    )
    amount = number_value(
        row.get("sizeUsd")
        or row.get("size_usd")
        or row.get("usdcSize")
        or row.get("usdc_size")
        or row.get("usdAmount")
        or row.get("usd_amount")
        or row.get("amountUsd")
        or row.get("amount_usd")
        or row.get("amountUSDC")
        or row.get("amount_usdc")
        or row.get("cash")
        or row.get("cashAmount")
        or row.get("cash_amount")
        or row.get("notional")
        or row.get("value")
        or row.get("valueUsd")
        or row.get("value_usd")
        or row.get("amount")
        or row.get("size")
        or row.get("shares")
    )
    extracted = {
        "address": address,
        "handle": handle,
        "trader_name": trader_name,
        "market_id": market_id,
        "side": side,
        "size_usd": amount,
        "timestamp": timestamp,
    }
    if row_type and not any(
        token in row_type.lower() for token in ("trade", "buy", "sell")
    ):
        return {
            "accepted": False,
            "reason": "unsupported row type",
            "sample_keys": sample_keys,
            "extracted": extracted,
        }
    if not address and not handle and not trader_name:
        return {
            "accepted": False,
            "reason": "missing trader identity",
            "sample_keys": sample_keys,
            "extracted": extracted,
        }
    if not market_id:
        return {
            "accepted": False,
            "reason": "missing market",
            "sample_keys": sample_keys,
            "extracted": extracted,
        }
    if not timestamp:
        return {
            "accepted": False,
            "reason": "missing timestamp",
            "sample_keys": sample_keys,
            "extracted": extracted,
        }
    if not amount or amount <= 0:
        return {
            "accepted": False,
            "reason": "missing amount",
            "sample_keys": sample_keys,
            "extracted": extracted,
        }
    price = clamp_price(
        number_value(
            row.get("price")
            or row.get("avgPrice")
            or row.get("avg_price")
            or row.get("averagePrice")
            or row.get("average_price")
            or row.get("outcomePrice")
            or row.get("outcome_price")
            or 0.5
        )
        or 0.5
    )
    trade_id = (
        string_value(
            row.get("id")
            or row.get("tradeId")
            or row.get("trade_id")
            or row.get("transactionHash")
            or row.get("txHash")
            or row.get("hash")
        )
        or f"{market_id}:{address}:{timestamp}:{side}"
    )
    return {
        "accepted": True,
        "sample_keys": sample_keys,
        "reason": "accepted",
        "trade": {
            "id": trade_id,
            "address": address,
            "handle": handle,
            "trader_name": trader_name,
            "raw_identity": raw_identity,
            "market_id": market_id,
            "market_title": string_value(
                row.get("title")
                or row.get("marketTitle")
                or row.get("market_title")
                or row.get("market")
                or row.get("question")
            )
            or market_id,
            "outcome": string_value(
                row.get("outcome")
                or row.get("outcomeName")
                or row.get("outcome_name")
                or row.get("token")
                or row.get("asset")
            )
            or "Yes",
            "side": side,
            "price": price,
            "size_usd": max(0.0, amount),
            "timestamp": timestamp,
        },
    }


def normalize_trade_rows_for_wallet(value: Any, address: str) -> list[dict[str, Any]]:
    normalized = [
        normalize_trade_row({**row, "address": extract_address(row) or address})
        for row in collect_rows(value)
    ]
    return [item["trade"] for item in normalized if item["accepted"]]


def dedupe_normalized_trade_rows(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for trade in trades:
        key = stable_trade_key("live-read", clean_trade_identity(trade), trade)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(trade)
    return deduped


def collect_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        rows: list[dict[str, Any]] = []
        for item in value:
            rows.extend(collect_rows(item))
        return rows
    if not isinstance(value, dict):
        return []

    direct_keys = [
        "data",
        "trades",
        "items",
        "results",
        "activity",
        "activities",
        "feed",
        "markets",
        "leaderboard",
        "profiles",
        "events",
    ]
    nested: list[dict[str, Any]] = []
    has_array = any(isinstance(value.get(key), list) for key in direct_keys) or any(
        isinstance(item, list) for item in value.values()
    )
    for key in direct_keys:
        nested.extend(collect_rows(value.get(key)))
    return [value, *nested] if not has_array else nested


def merge_traders(traders: list[PolymarketTrader]) -> list[PolymarketTrader]:
    merged: dict[str, PolymarketTrader] = {}
    for trader in traders:
        key = identity_key(trader.address or trader.handle or trader.name or trader.id)
        existing = merged.get(key)
        if not existing:
            merged[key] = trader
            continue
        merged[key] = PolymarketTrader(
            **{
                **existing.model_dump(),
                "volume_24h": max(existing.volume_24h, trader.volume_24h),
                "trades_1h": max(existing.trades_1h, trader.trades_1h),
                "trades_6h": max(existing.trades_6h, trader.trades_6h),
                "trades_24h": max(existing.trades_24h, trader.trades_24h),
                "last_trade_at": newest_iso(
                    existing.last_trade_at, trader.last_trade_at
                ),
                "last_trade_age": (
                    trader.last_trade_age
                    if newest_iso(existing.last_trade_at, trader.last_trade_at)
                    == trader.last_trade_at
                    else existing.last_trade_age
                ),
                "handle": existing.handle or trader.handle,
                "profile_slug": existing.profile_slug or trader.profile_slug,
                "profile_url": existing.profile_url or trader.profile_url,
                "activity_url": existing.activity_url or trader.activity_url,
                "activity_source": (
                    existing.activity_source
                    if existing.trades_24h >= trader.trades_24h
                    else trader.activity_source
                ),
                "source_reason": (
                    "Manual tracked wallet"
                    if "Manual" in existing.source_reason
                    or "Manual" in trader.source_reason
                    else existing.source_reason
                ),
            }
        )
    return list(merged.values())


def compare_trader_key(trader: PolymarketTrader) -> tuple[int, int, float]:
    return (activity_bucket(trader), trader.trades_24h, trader.volume_24h)


def activity_bucket(trader: PolymarketTrader) -> int:
    if trader.trades_1h > 0:
        return 3
    if trader.trades_6h > 0:
        return 2
    if trader.trades_24h > 0:
        return 1
    return 0


def dedupe_trades(trades: list[PolymarketSourceTrade]) -> list[PolymarketSourceTrade]:
    seen: set[str] = set()
    deduped: list[PolymarketSourceTrade] = []
    for trade in trades:
        key = (
            trade.source_trade_key
            or f"{trade.source}:{trade.id}:{identity_key(trade.clean_trader_identity)}"
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(trade)
    return deduped


def parse_manual_wallets(value: str) -> dict[str, list[str]]:
    raw = [item.strip() for item in value.split(",") if item.strip()]
    valid: list[str] = []
    invalid: list[str] = []
    for target in raw:
        cleaned_wallet = clean_wallet_prefix(target)
        cleaned_handle = clean_handle(target) or clean_handle(target.rsplit("/", 1)[-1])
        if cleaned_wallet:
            valid.append(cleaned_wallet)
        elif cleaned_handle:
            valid.append(cleaned_handle)
        else:
            invalid.append(target)
    return {"valid": list(dict.fromkeys(valid)), "invalid": invalid}


def clamp_price(price: float) -> float:
    if not isinstance(price, (int, float)):
        return 0.5
    return min(0.99, max(0.01, float(price)))


def is_public_wallet_address(address: str) -> bool:
    import re

    return bool(re.fullmatch(r"0x[a-fA-F0-9]{40}", address or ""))


def polymarket_profile_url(address: str) -> str | None:
    return (
        f"https://polymarket.com/profile/{address}"
        if is_public_wallet_address(address)
        else None
    )


def polymarket_handle_profile_url(handle: str | None) -> str | None:
    slug = clean_handle(handle)
    return f"https://polymarket.com/@{slug}" if slug else None


def polymarket_handle_activity_url(handle: str | None) -> str | None:
    base = polymarket_handle_profile_url(handle)
    return f"{base}?tab=activity" if base else None


def safe_http_url(value: object) -> str | None:
    from urllib.parse import urlparse

    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    return value if parsed.scheme in {"http", "https"} else None


def extract_address(row: dict[str, Any]) -> str | None:
    candidates = [
        row.get("address"),
        row.get("wallet"),
        row.get("trader"),
        row.get("user"),
        row.get("userAddress"),
        row.get("user_address"),
        row.get("proxyWallet"),
        row.get("proxy_wallet"),
        row.get("owner"),
        row.get("maker"),
        row.get("taker"),
        row.get("profileAddress"),
        row.get("creator"),
        row.get("account"),
    ]
    for value in candidates:
        cleaned = extract_address_value(value)
        if cleaned:
            return cleaned
    return None


def extract_address_value(value: object) -> str | None:
    cleaned = clean_wallet_prefix(string_value(value))
    if cleaned:
        return cleaned
    if not isinstance(value, dict):
        return None
    return extract_address(
        {
            "address": value.get("address"),
            "wallet": value.get("wallet"),
            "userAddress": value.get("userAddress"),
            "user_address": value.get("user_address"),
            "proxyWallet": value.get("proxyWallet"),
            "proxy_wallet": value.get("proxy_wallet"),
            "profileAddress": value.get("profileAddress"),
            "account": value.get("account"),
        }
    )


def extract_handle(row: dict[str, Any]) -> str | None:
    profile = row.get("profile") if isinstance(row.get("profile"), dict) else {}
    value = string_value(
        row.get("handle")
        or row.get("profileSlug")
        or row.get("profile_slug")
        or row.get("username")
        or row.get("user_name")
        or row.get("name")
        or row.get("pseudonym")
        or profile.get("slug")
    )
    return clean_handle(value)


def parse_timestamp(value: object) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        millis = value if value > 10_000_000_000 else value * 1000
        return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat()
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        numeric = float(value)
        return parse_timestamp(numeric)
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.astimezone(timezone.utc).isoformat()


def clean_handle(value: object) -> str | None:
    raw = string_value(value)
    if not raw:
        return None
    cleaned = raw.lstrip("@").strip()
    if not cleaned or clean_wallet_prefix(cleaned):
        return None
    return cleaned


def handle_from_name(value: object) -> str | None:
    return clean_handle(value)


def identity_key(value: str) -> str:
    return value.lstrip("@").strip().lower()


def trader_identity_candidates(trader: PolymarketTrader) -> set[str]:
    values = [
        trader.address,
        trader.handle,
        trader.profile_slug,
        trader.name,
        trader.id,
    ]
    return {identity_key(item) for item in values if item}


def stable_trade_key(source: TradeSource, identity: str, trade: dict[str, Any]) -> str:
    return ":".join(
        [
            source,
            identity_key(identity),
            identity_key(trade["market_id"]),
            identity_key(trade["outcome"]),
            trade["side"],
            trade["timestamp"],
            f"{float(trade['size_usd']):.6f}",
            f"{float(trade['price']):.4f}",
        ]
    )


def select_tracked_traders(
    traders: list[PolymarketTrader],
    manual: list[PolymarketTrader],
    max_tracked: int,
) -> list[PolymarketTrader]:
    limit = max(1, max_tracked or 10)
    manual_selected = sorted(
        merge_traders(manual), key=compare_trader_key, reverse=True
    )
    if manual_selected:
        return manual_selected[:limit]
    return sorted(merge_traders(traders), key=compare_trader_key, reverse=True)[:limit]


def clean_wallet_prefix(value: object) -> str | None:
    import re

    raw = string_value(value)
    if not raw:
        return None
    match = re.match(r"^0x[a-fA-F0-9]{40}", raw)
    return match.group(0) if match else None


def raw_identity_value(row: dict[str, Any]) -> str | None:
    return string_value(
        row.get("address")
        or row.get("wallet")
        or row.get("trader")
        or row.get("user")
        or row.get("userAddress")
        or row.get("user_address")
        or row.get("proxyWallet")
        or row.get("proxy_wallet")
        or row.get("owner")
        or row.get("maker")
        or row.get("taker")
        or row.get("profileAddress")
        or row.get("creator")
        or row.get("account")
        or row.get("handle")
        or row.get("profileSlug")
        or row.get("profile_slug")
        or row.get("username")
        or row.get("user_name")
        or row.get("name")
        or row.get("pseudonym")
    )


def clean_trade_identity(
    trade: dict[str, Any], trader: PolymarketTrader | None = None
) -> str | None:
    address = clean_wallet_prefix(trade.get("address")) or (
        clean_wallet_prefix(trader.address) if trader else None
    )
    if address:
        return address
    return (
        clean_handle(trade.get("handle"))
        or (clean_handle(trader.handle) if trader else None)
        or clean_handle(trade.get("trader_name"))
        or (clean_handle(trader.name) if trader else None)
    )


def newest_iso(a: str | None, b: str | None) -> str | None:
    if not a:
        return b
    if not b:
        return a
    return a if datetime.fromisoformat(a) >= datetime.fromisoformat(b) else b


def age_label(age_ms: float) -> str:
    if age_ms < 0:
        return "unknown"
    minutes = int(age_ms // 60_000)
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h ago"
    return f"{hours // 24}d ago"


def short_address(address: str) -> str:
    if not address or len(address) < 12:
        return address or ""
    return f"{address[:6]}...{address[-4:]}"


def redact_manual_wallet_input(value: str) -> str:
    if not value:
        return "[empty]"
    if len(value) <= 10:
        return f"{value[:2]}..."
    return f"{value[:6]}...{value[-4:]}"


def string_value(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def number_value(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str):
        return None
    try:
        return float(value.replace("$", "").replace(",", ""))
    except ValueError:
        return None


def safe_command_args(args: list[str]) -> list[str]:
    return ["[address]" if is_public_wallet_address(arg) else arg for arg in args]


async def run_debug_command(
    label: str, args: list[str], report: PolymarketDiscoveryDebugReport
) -> object | None:
    report.commands_attempted.append(
        PolymarketDiscoveryDebugCommand(label=label, args=safe_command_args(args))
    )
    try:
        return await run_bullpen_json(args)
    except Exception as exc:
        report.errors.append(
            PolymarketDiscoveryDebugError(
                command=label,
                error=redact_secrets(str(exc)).replace(
                    "0x", "[address]" if "0x" in str(exc) else "0x"
                ),
            )
        )
        return None


def add_debug_rows(
    report: PolymarketDiscoveryDebugReport, parsed: object
) -> list[dict[str, Any]]:
    rows = collect_rows(parsed)
    report.rows_returned_count += len(rows)
    report.sample_row_keys.extend([list(row.keys())[:40] for row in rows[:5]])
    normalized = [normalize_trade_row(row) for row in rows]
    accepted: list[dict[str, Any]] = []
    for item in normalized:
        if item["accepted"]:
            trade = item["trade"]
            report.accepted_trades_count += 1
            report.accepted.append(
                PolymarketDiscoveryDebugAccepted(
                    address="[address]" if trade.get("address") else None,
                    clean_identity=(
                        "[address]"
                        if trade.get("address")
                        else (trade.get("handle") or trade.get("trader_name"))
                    ),
                    raw_identity=(
                        redact_secrets(str(trade.get("raw_identity"))).replace(
                            trade.get("address") or "", "[address]"
                        )
                        if trade.get("raw_identity")
                        else None
                    ),
                    handle=trade.get("handle"),
                    username=trade.get("trader_name"),
                    market=trade.get("market_id"),
                    title=trade.get("market_title"),
                    outcome=trade.get("outcome"),
                    side=trade.get("side"),
                    price=trade.get("price"),
                    amount=trade.get("size_usd"),
                    timestamp=trade.get("timestamp"),
                    reason=item["reason"],
                )
            )
            accepted.append(item["trade"])
        else:
            report.rejected_rows_count += 1
            extracted = dict(item["extracted"])
            if extracted.get("address"):
                extracted["address"] = "[address]"
            report.rejected.append(
                PolymarketDiscoveryDebugRejected(
                    keys=item["sample_keys"], reason=item["reason"], extracted=extracted
                )
            )
    return accepted


def add_debug_candidates(
    report: PolymarketDiscoveryDebugReport, parsed: object
) -> str | None:
    rows = collect_rows(parsed)
    for row in rows[:10]:
        address = extract_address(row)
        handle = extract_handle(row)
        username = string_value(
            row.get("username") or row.get("user_name") or row.get("name")
        )
        report.candidates.append(
            PolymarketDiscoveryDebugCandidate(
                address="[address]" if address else None,
                handle=handle,
                username=username,
                profile_slug=handle,
            )
        )
    for row in rows:
        address = extract_address(row)
        if address:
            return address
    return None


async def debug_discovery(target: str) -> PolymarketDiscoveryDebugReport:
    handle = clean_handle(target) or target
    report = PolymarketDiscoveryDebugReport(target=handle)

    feed = await run_debug_command(
        "feed trades",
        [
            "polymarket",
            "feed",
            "trades",
            "--read-only",
            "--non-interactive",
            "--limit",
            "1000",
            "--output",
            "json",
        ],
        report,
    )
    feed_accepted = add_debug_rows(report, feed) if feed else []
    handle_key = identity_key(handle)
    feed_hits = [
        item
        for item in feed_accepted
        if handle_key
        in {
            identity_key(str(value))
            for value in [
                item.get("address"),
                item.get("handle"),
                item.get("trader_name"),
            ]
            if value
        }
    ]

    activity = await run_debug_command(
        "activity",
        [
            "polymarket",
            "activity",
            "--read-only",
            "--non-interactive",
            "--limit",
            "20",
            "--output",
            "json",
        ],
        report,
    )
    if activity:
        add_debug_rows(report, activity)

    search = await run_debug_command(
        "search handle",
        [
            "polymarket",
            "search",
            handle,
            "--type",
            "user",
            "--limit",
            "5",
            "--read-only",
            "--non-interactive",
            "--output",
            "json",
        ],
        report,
    )
    address = add_debug_candidates(report, search) if search else None

    profile_by_handle = await run_debug_command(
        "profile handle",
        [
            "polymarket",
            "data",
            "profile",
            handle,
            "--read-only",
            "--non-interactive",
            "--output",
            "json",
        ],
        report,
    )
    if profile_by_handle:
        add_debug_rows(report, profile_by_handle)

    profile_at_handle = await run_debug_command(
        "profile @handle",
        [
            "polymarket",
            "data",
            "profile",
            f"@{handle}",
            "--read-only",
            "--non-interactive",
            "--output",
            "json",
        ],
        report,
    )
    if profile_at_handle:
        add_debug_rows(report, profile_at_handle)

    if address:
        by_address = await run_debug_command(
            "activity address",
            [
                "polymarket",
                "activity",
                "--address",
                address,
                "--type",
                "trade",
                "--read-only",
                "--non-interactive",
                "--limit",
                "20",
                "--output",
                "json",
            ],
            report,
        )
        if by_address:
            add_debug_rows(report, by_address)

    if feed_hits:
        report.accepted = [
            item
            for item in report.accepted
            if identity_key(item.handle or item.username or "") == handle_key
        ][:5]
        report.accepted_trades_count = len(feed_hits)
    else:
        report.accepted = report.accepted[:5]
    report.rejected = report.rejected[:20]
    report.sample_row_keys = report.sample_row_keys[:20]
    return report
