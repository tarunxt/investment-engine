"""Admission evidence, NOT heuristic pricing or a billing-settings surface.

No current production adapter has a verified all-in INR ceiling. In particular
repository USD rates, chars/4, SDK defaults and a planning FX rate are NOT bounds.
Do not enable an adapter until its input/output/reasoning/tool/retry/FX/fee bounds
and settlement proof are implemented and reviewed together.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
from typing import Callable, Mapping

from .ledger import SpendCapBlocked, money


@dataclass(frozen=True)
class ConfirmedCharge:
    inr: Decimal
    receipt: str
    # A final response/request ID alone is not proof of every possibly billed
    # transport attempt or the actual INR settlement terms.
    transport_receipts: tuple[str, ...] = ()
    all_transport_attempts_accounted: bool = False
    settlement_reference: str | None = None
    tariff_version: str | None = None
    fx_version: str | None = None
    currency: str | None = None
    includes_taxes_and_fees: bool = False

    def validate(self, bound: "RequestBound"):
        money(self.inr)
        if (not isinstance(self.receipt, str) or not self.receipt.strip() or len(self.receipt) > 255
                or self.currency != "INR" or self.includes_taxes_and_fees is not True
                or self.all_transport_attempts_accounted is not True
                or not isinstance(self.settlement_reference, str) or not self.settlement_reference.strip() or len(self.settlement_reference) > 255
                or self.tariff_version != bound.tariff_version or self.fx_version != bound.fx_version
                or not isinstance(self.transport_receipts, tuple) or not self.transport_receipts
                or len(self.transport_receipts) > bound.limits.transport_attempts
                or any(not isinstance(value, str) or not value.strip() or len(value) > 255 for value in self.transport_receipts)
                or len(set(self.transport_receipts)) != len(self.transport_receipts)):
            raise SpendCapBlocked("All-attempt actual INR settlement evidence is incomplete")

    def digest(self):
        payload = {"inr": str(money(self.inr)), "receipt": self.receipt,
            "transport_receipts": self.transport_receipts,
            "all_transport_attempts_accounted": self.all_transport_attempts_accounted,
            "settlement_reference": self.settlement_reference, "tariff_version": self.tariff_version,
            "fx_version": self.fx_version, "currency": self.currency,
            "includes_taxes_and_fees": self.includes_taxes_and_fees}
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class FiniteRequestLimits:
    """Evidence contract for a reviewed adapter, not frontend configuration.

    Generated tokens include hidden reasoning. Counts include every hidden SDK
    retry and server-side tool charge inside this one admitted boundary. An
    adapter must enforce these limits and provide a reviewed evidence reference;
    merely constructing this object does not certify a provider.
    """
    input_tokens: int
    generated_tokens: int
    search_requests: int
    transport_attempts: int
    duration_seconds: int
    enforcement_reference: str
    includes_hidden_reasoning: bool = False
    includes_all_tool_charges: bool = False

    def validate(self):
        for value in (self.input_tokens, self.generated_tokens, self.search_requests):
            if type(value) is not int or value < 0:
                raise SpendCapBlocked("Finite request limits are unavailable")
        for value in (self.transport_attempts, self.duration_seconds):
            if type(value) is not int or value <= 0:
                raise SpendCapBlocked("Finite transport/deadline limits are unavailable")
        if (self.includes_hidden_reasoning is not True or self.includes_all_tool_charges is not True
                or not isinstance(self.enforcement_reference, str) or not self.enforcement_reference.strip()):
            raise SpendCapBlocked("Reviewed reasoning/tool/transport enforcement evidence is required")


@dataclass(frozen=True)
class ConfirmedRefund:
    inr: Decimal
    refund_key: str
    original_receipt: str
    settlement_reference: str
    currency: str | None = None
    actually_settled: bool = False

    def validate(self):
        money(self.inr, positive=True)
        if (self.currency != "INR" or self.actually_settled is not True
                or any(not isinstance(value, str) or not value.strip() or len(value) > maximum
                    for value, maximum in ((self.refund_key, 128), (self.original_receipt, 255),
                        (self.settlement_reference, 255)))):
            raise SpendCapBlocked("Actual INR refund settlement evidence is incomplete")

    def digest(self):
        self.validate()
        payload = {"inr": str(money(self.inr, positive=True)), "refund_key": self.refund_key,
            "original_receipt": self.original_receipt, "settlement_reference": self.settlement_reference,
            "currency": self.currency, "actually_settled": self.actually_settled}
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class RequestBound:
    upper_inr: Decimal
    tariff_version: str
    fx_version: str
    valid_until: datetime
    # Only verified provider/contract evidence may free a reservation. The
    # telemetry tariff estimate is deliberately not used by the runtime.
    confirmed_charge: Callable[[Mapping], ConfirmedCharge | None]
    limits: FiniteRequestLimits | None = None

    def validate(self):
        money(self.upper_inr, positive=True)
        if not isinstance(self.limits, FiniteRequestLimits):
            raise SpendCapBlocked("Certified finite request/transport limits unavailable")
        self.limits.validate()
        if (not self.tariff_version or not self.fx_version or not callable(self.confirmed_charge)
                or not isinstance(self.valid_until, datetime)
                or self.valid_until.tzinfo is None or self.valid_until <= datetime.now(timezone.utc)):
            raise SpendCapBlocked("Verified current tariff and all-in INR request bounds unavailable")
        try:
            deadline = datetime.now(timezone.utc) + timedelta(seconds=self.limits.duration_seconds)
        except OverflowError:
            raise SpendCapBlocked("Finite request/retry duration is invalid") from None
        if self.valid_until <= deadline:
            raise SpendCapBlocked("Tariff/FX bounds expire before the maximum request/retry duration")


def resolve_bound(*, provider: str, model: str | None, request: object) -> RequestBound:
    # Intentionally no configurable override, header, frontend-supplied amount,
    # paid probing call, tariff download or new billing/security route.
    raise SpendCapBlocked(
        f"₹20 rebalance cap: {provider}/{model or 'search'} has no verified price, FX/fee and request "
        "upper bound. No paid request was dispatched. Saved outputs are preserved."
    )
