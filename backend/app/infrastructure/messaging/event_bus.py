from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from collections.abc import Callable, Coroutine
from typing import Any

logger = logging.getLogger(__name__)

Handler = Callable[[Any], Coroutine[Any, Any, None]]


class EventBus:
    """In-process async event bus. Subscriptions are wired once at startup."""

    def __init__(self) -> None:
        self._handlers: dict[type, list[Handler]] = defaultdict(list)

    def subscribe(self, event_type: type, handler: Handler) -> None:
        self._handlers[event_type].append(handler)

    async def publish(self, event: Any) -> None:
        handlers = self._handlers.get(type(event), [])
        if not handlers:
            return
        results = await asyncio.gather(
            *[h(event) for h in handlers], return_exceptions=True
        )
        for exc in results:
            if isinstance(exc, Exception):
                logger.error(
                    "Event handler %s failed for %s: %s",
                    type(exc).__name__,
                    type(event).__name__,
                    exc,
                    exc_info=exc,
                )


# Module-level singleton — import and wire handlers in main.py lifespan.
event_bus = EventBus()
