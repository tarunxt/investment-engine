"""Admission evidence, NOT heuristic pricing or a billing-settings surface.

No current production adapter has a verified all-in INR ceiling. In particular
repository USD rates, chars/4, SDK defaults and a planning FX rate are NOT bounds.
Do not enable an adapter until its input/output/reasoning/tool/retry/FX/fee bounds
and settlement proof are implemented and reviewed together.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Mapping

from .ledger import SpendCapBlocked, money


@dataclass(frozen=True)
class ConfirmedCharge:
    inr: Decimal
    receipt: str


@dataclass(frozen=True)
class RequestBound:
    upper_inr: Decimal
    tariff_version: str
    fx_version: str
    valid_until: datetime
    # Only verified provider/contract evidence may free a reservation. The
    # telemetry tariff estimate is deliberately not used by the runtime.
    confirmed_charge: Callable[[Mapping], ConfirmedCharge | None]

    def validate(self):
        money(self.upper_inr, positive=True)
        if (not self.tariff_version or not self.fx_version or not callable(self.confirmed_charge)
                or not isinstance(self.valid_until, datetime)
                or self.valid_until.tzinfo is None or self.valid_until <= datetime.now(timezone.utc)):
            raise SpendCapBlocked("Verified current tariff and all-in INR request bounds unavailable")


def resolve_bound(*, provider: str, model: str | None, request: object) -> RequestBound:
    # Intentionally no configurable override, header, frontend-supplied amount,
    # paid probing call, tariff download or new billing/security route.
    raise SpendCapBlocked(
        f"₹20 rebalance cap: {provider}/{model or 'search'} has no verified price, FX/fee and request "
        "upper bound. No paid request was dispatched. Saved outputs are preserved."
    )
