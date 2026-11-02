import os
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
from datetime import datetime, date, timezone
from copy import deepcopy
import pytest
from app.domains.cost_drivers import service, billing


def window(amount="1.824", name=None, unit="USD", estimated=True):
    metrics = {"UnblendedCost": {"Amount": amount, "Unit": unit}, "UsageQuantity": {"Amount": "20", "Unit": "GB"}}
    return {"TimePeriod": {"Start": "2026-10-01", "End": "2026-11-01"}, "Estimated": estimated,
            "Groups": [{"Keys": [name], "Metrics": metrics}] if name else [], "Total": metrics}


def collect(monkeypatch, fake):
    monkeypatch.setattr(service, "_aws_client", lambda *args: fake)
    diagnostics = []
    result = service._collect_cost_explorer(datetime.now(timezone.utc), 31, 31, diagnostics, date(2026, 10, 1), date(2026, 11, 1))
    return result, diagnostics


def test_two_pages_precision_credit_and_estimate(monkeypatch):
    class CE:
        def get_cost_and_usage(self, **request):
            if not request.get("GroupBy"):
                return {"ResultsByTime": [window("1.8239")]}
            if request.get("NextPageToken"):
                return {"ResultsByTime": [window("-0.0001", "Credit")]}
            return {"ResultsByTime": [window(name="Storage")], "NextPageToken": "next"}
    result, _ = collect(monkeypatch, CE())
    assert result["mtd_cost"] == 1.8239
    assert len(result["top_services"]) == 2
    assert result["top_services"][1]["rawCost"] == "-0.0001"
    p = result["provenance"]
    assert p["complete"] and p["estimateState"] == "estimated"
    assert p["rawTotals"] == dict.fromkeys(["daily", "services", "usage"], "1.8239")
    assert p["meter"]["requests"] == 5 and p["dataCutoff"] is None


@pytest.mark.parametrize("failure", ["repeat", "expired", "cap", "duplicate"])
def test_incomplete_pages_never_complete(failure, monkeypatch):
    class CE:
        calls = 0
        def get_cost_and_usage(self, **request):
            self.calls += 1
            if request.get("NextPageToken") and failure == "expired":
                raise RuntimeError("synthetic expired token")
            name = "same" if failure == "duplicate" else str(self.calls)
            token = "same" if failure == "repeat" else str(self.calls)
            return {"ResultsByTime": [window(name=name)], "NextPageToken": token}
    result, _ = collect(monkeypatch, CE())
    assert not result["provenance"]["complete"]
    assert result["provenance"]["meter"]["requests"] <= 30


def test_currency_conflict_is_explicit(monkeypatch):
    class CE:
        def get_cost_and_usage(self, **request):
            return {"ResultsByTime": [window(name="Storage" if request.get("GroupBy") else None, unit="EUR" if request.get("GroupBy") else "USD")]}
    result, diagnostics = collect(monkeypatch, CE())
    assert not result["loaded"]
    assert "currency" in result["provenance"]["error"]
    assert diagnostics[-1]["status"] == "error"


def test_usage_unit_conflict():
    first, second = window(name="same"), window(name="same")
    second["Groups"][0]["Metrics"]["UsageQuantity"]["Unit"] = "Hours"
    with pytest.raises(ValueError, match="units"):
        billing.grouped_rows([first, second], set())
