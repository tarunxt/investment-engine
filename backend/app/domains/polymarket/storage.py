from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Generic, TypeVar

from pydantic import BaseModel

ModelT = TypeVar("ModelT", bound=BaseModel)


class JsonModelStore(Generic[ModelT]):
    def __init__(self, file_path: Path, model_cls: type[ModelT]) -> None:
        self.file_path = file_path
        self.model_cls = model_cls
        self._lock = asyncio.Lock()

    async def load(self) -> list[ModelT]:
        async with self._lock:
            if not self.file_path.exists():
                await asyncio.to_thread(
                    self.file_path.parent.mkdir, parents=True, exist_ok=True
                )
                await asyncio.to_thread(
                    self.file_path.write_text, "[]\n", encoding="utf-8"
                )
                return []
            raw = await asyncio.to_thread(self.file_path.read_text, encoding="utf-8")
            items = json.loads(raw or "[]")
            if not isinstance(items, list):
                return []
            return [self.model_cls.model_validate(item) for item in items]

    async def save(self, items: list[ModelT]) -> None:
        async with self._lock:
            await asyncio.to_thread(
                self.file_path.parent.mkdir, parents=True, exist_ok=True
            )
            payload = json.dumps(
                [item.model_dump(mode="json") for item in items], indent=2
            )
            await asyncio.to_thread(
                self.file_path.write_text, f"{payload}\n", encoding="utf-8"
            )
