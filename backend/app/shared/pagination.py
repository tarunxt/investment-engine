from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class PagedQuery:
    page: int = 1
    limit: int = 20

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit


@dataclass(frozen=True)
class PagedResult(Generic[T]):
    items: list[T]
    total: int
    page: int
    limit: int

    @property
    def pages(self) -> int:
        return max(1, (self.total + self.limit - 1) // self.limit)

    def to_dict(self) -> dict:
        return {
            "items": self.items,
            "total": self.total,
            "page": self.page,
            "limit": self.limit,
            "pages": self.pages,
        }
