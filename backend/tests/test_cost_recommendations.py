import os
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.cost_drivers.recommendations import (
    generateDataTransferRecommendation,
    generateTransferFamilyRecommendation,
    generateUnattachedEbsRecommendation,
)
from app.domains.cost_drivers.service import _mock_dashboard


def test_transfer_family_recommendation_is_null_when_list_servers_empty():
    assert generateTransferFamilyRecommendation({"servers": [], "billingCostUsd": 0}) is None


def test_transfer_family_recommendation_is_critical_only_for_active_servers():
    rec = generateTransferFamilyRecommendation({"servers": [{"ServerId": "s-123", "State": "ONLINE"}]})
    assert rec is not None
    assert rec["severity"] == "critical"
    assert rec["confidence"] == "confirmed"


def test_transfer_family_missing_permission_is_not_checked_diagnostic_not_critical():
    rec = generateTransferFamilyRecommendation({"permissionMissing": True})
    assert rec is not None
    assert rec["severity"] == "info"
    assert rec["confidence"] == "not_checked"
    assert "missing permission transfer:ListServers" in rec["title"]


def test_ebs_recommendation_is_null_when_no_available_volumes():
    assert generateUnattachedEbsRecommendation({"volumes": [{"VolumeId": "vol-1", "State": "in-use", "Size": 8}]}) is None


def test_ebs_recommendation_appears_only_for_available_unattached_volumes():
    rec = generateUnattachedEbsRecommendation({"volumes": [{"VolumeId": "vol-available123", "State": "available", "Size": 32, "ageDays": 21}]})
    assert rec is not None
    assert rec["confidence"] == "confirmed"
    assert any(item["label"] == "Unattached volumes" and item["value"] == 1 for item in rec["evidence"])
    assert any(item["label"] == "Total unattached storage" and item["value"] == 32 for item in rec["evidence"])


def test_data_transfer_warning_only_when_threshold_or_projection_exceeded():
    assert generateDataTransferRecommendation({"usedGb": 40, "projectedGb": 80}) is None
    assert generateDataTransferRecommendation({"usedGb": 80, "projectedGb": 90}) is not None
    assert generateDataTransferRecommendation({"usedGb": 40, "projectedGb": 120}) is not None


def test_mock_recommendations_use_demo_confidence_badge_data():
    data = _mock_dashboard()
    assert data["debug"]["mockMode"] is True
    assert data["recommendations"]
    assert all(rec["confidence"] == "demo" for rec in data["recommendations"])
    assert all(rec["source"] == "mock" for rec in data["recommendations"])


def test_frontend_does_not_render_empty_confidence_label():
    with open("../frontend/app/console/profile/cost-drivers/page.tsx", encoding="utf-8") as handle:
        page = handle.read()
    assert ">confidence:" not in page.lower()
