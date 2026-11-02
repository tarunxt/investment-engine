import pytest
from app.domains.cost_drivers.storage_pricing import estimate_storage


def volume(**kwargs):
    return dict(region="ap-south-1", type="gp3", sizeGb=20, iops=3000, throughput=125, **kwargs)


def test_mumbai_baseline_is_gross_exposure_only():
    result = estimate_storage([volume()])
    assert result["grossMonthlyExposureUsd"] == "1.8240"
    assert result["approvedRemovableSavingsUsd"] is None
    assert result["actualBillUsd"] is None
    assert "backups" in result["exclusions"]


def test_other_region_type_and_provisioned_extras():
    result = estimate_storage([dict(region="us-east-1", type="gp2", sizeGb=20)])
    assert result["grossMonthlyExposureUsd"] is None
    assert result["state"] == "unpriced"
    extra = volume()
    extra.update(iops=4000, throughput=200)
    # Mumbai extra tariffs are intentionally unknown without retained evidence.
    assert estimate_storage([extra])["grossMonthlyExposureUsd"] is None


@pytest.mark.parametrize("field,value", [("sizeGb", -1), ("sizeGb", "nan"), ("iops", "inf"), ("throughput", "bad"), ("region", "unknown"), ("type", "io2"), ("iops", None)])
def test_invalid_or_unpriced_never_defaults(field, value):
    row = volume()
    row[field] = value
    result = estimate_storage([row])
    assert result["state"] == "unpriced"
    assert result["grossMonthlyExposureUsd"] is None


def test_override_requires_provenance_and_preserves_rate():
    assert estimate_storage([volume()], "0.12")["state"] == "unpriced"
    result = estimate_storage([volume()], "0.12", "operator supplied tariff", "2026-11-01")
    assert result["grossMonthlyExposureUsd"] == "2.40"
    assert result["volumes"][0]["source"] == "operator supplied tariff"
    assert estimate_storage([volume()], "-1", "operator", "2026-11-01")["state"] == "unpriced"
