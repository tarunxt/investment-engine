from pydantic import BaseModel, Field


class RankingQuery(BaseModel):
    code: str = Field(min_length=1, max_length=24, pattern=r"^[a-z0-9]+$")
    name: str = Field(min_length=1, max_length=200)
    competition_id: str | None = Field(default=None, max_length=240)


class EventComparisonItem(BaseModel):
    market_id: str = Field(min_length=1, max_length=240)
    event_slug: str | None = Field(default=None, max_length=300)
    event_title: str | None = Field(default=None, max_length=500)


class EventComparisonsQuery(BaseModel):
    events: list[EventComparisonItem] = Field(min_length=1, max_length=200)


class RefreshRequest(BaseModel):
    source_id: str = Field(min_length=1, max_length=80)
