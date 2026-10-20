from __future__ import annotations

from app.domains.polymarket.access import require_operator_user_id
from app.domains.polymarket_auto_live.bot import BullpenAutoLiveBot


class BullpenAutoLiveBotManager:
    async def get_bot(self, user_id: int) -> BullpenAutoLiveBot:
        await require_operator_user_id(user_id)
        return BullpenAutoLiveBot(user_id=user_id)

    async def shutdown(self) -> None:
        return None


polymarket_auto_live_bot_manager = BullpenAutoLiveBotManager()
