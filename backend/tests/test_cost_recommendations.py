import os
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.cost_drivers.recommendations import (
    generateCloudWatchLogsRecommendation,
    generateCostExplorerRecommendation,
    generateDataTransferRecommendation,
    generateLightsailRecommendation,
    generateOversizedEc2Recommendation,
    generatePublicIpv4Recommendation,
    generateTransferFamilyRecommendation,
    generateUnattachedEbsRecommendation,
)
from app.domains.cost_drivers.cache import reset_local_cost_dashboard_cache_state
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


def test_data_transfer_recommendation_reports_projected_overage_cost():
    rec = generateDataTransferRecommendation(
        {
            "usedGb": 92,
            "projectedGb": 130,
            "projectedOverageGb": 30,
            "projectedOverageUsd": 2.7,
        }
    )
    assert rec is not None
    assert rec["estimatedMonthlySavingsUsd"] == 2.7
    assert any(item["label"] == "Projected overage cost" and item["value"] == 2.7 for item in rec["evidence"])


def test_evidence_based_recommendations_only_show_savings_when_supported():
    cloudwatch = generateCloudWatchLogsRecommendation(
        {
            "logGroups": [{"name": "/cred-x/backend", "retentionDays": None, "storedGb": 3.4}],
            "estimatedMonthlySavingsUsd": 0.1,
        }
    )
    public_ipv4 = generatePublicIpv4Recommendation(
        {"count": 2, "projectedMonthlyCostUsd": 7.2, "estimatedMonthlySavingsUsd": 7.2}
    )
    ec2 = generateOversizedEc2Recommendation(
        {
            "instances": [
                {"instanceId": "i-123", "instanceType": "t3.small", "cpuAveragePct": 8, "cpuMaxPct": 22}
            ]
        }
    )
    lightsail = generateLightsailRecommendation(
        {
            "instances": [],
            "staticIps": [{"name": "legacy-ip"}],
            "disks": [],
            "snapshots": [],
            "billingCostUsd": 4.5,
        }
    )
    cost_explorer = generateCostExplorerRecommendation(
        {"loaded": False, "status": "error", "message": "AccessDenied"}
    )

    assert cloudwatch is not None and cloudwatch["estimatedMonthlySavingsUsd"] == 0.1
    assert public_ipv4 is not None and public_ipv4["estimatedMonthlySavingsUsd"] == 7.2
    assert ec2 is not None and ec2["estimatedMonthlySavingsUsd"] is None
    assert lightsail is not None and lightsail["estimatedMonthlySavingsUsd"] is None
    assert cost_explorer is not None and cost_explorer["estimatedMonthlySavingsUsd"] is None


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


def test_cost_dashboard_defaults_to_live_empty_when_mock_mode_unset(monkeypatch):
    from app.domains.cost_drivers import service

    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    reset_local_cost_dashboard_cache_state()
    monkeypatch.setattr(service, "claim_refresh_cooldown", lambda *args, **kwargs: None)
    monkeypatch.setattr(service, "_live_dashboard", lambda month=None: service._empty_live_dashboard(month))

    data = service.get_dashboard(force_refresh=True)

    assert data["debug"]["mockMode"] is False
    assert data["traffic"] == []
    assert data["recommendations"] == []


def test_mock_dashboard_excludes_nonexistent_media_asset_placeholders():
    data = _mock_dashboard()
    paths = {row["path"] for row in data["traffic"]}

    assert "/media/hero-loan-video.mp4" not in paths
    assert "/images/home-banner.png" not in paths
