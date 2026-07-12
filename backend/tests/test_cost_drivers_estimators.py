from app.domains.cost_drivers.estimators import (
    classify_traffic_path,
    estimate_cloudwatch_logs_cost,
    estimate_data_transfer_cost,
    estimate_ebs_cost,
    estimate_ec2_monthly_cost,
    estimate_projected_month_end,
    estimate_public_ipv4_cost,
)
from app.domains.cost_drivers.transfer import (
    TRANSFER_CATEGORY_INBOUND,
    TRANSFER_CATEGORY_INTER_AZ,
    TRANSFER_CATEGORY_INTERNET_EGRESS,
    TRANSFER_CATEGORY_NAT,
    TRANSFER_CATEGORY_OTHER,
    classify_aws_transfer_usage_type,
    summarize_transfer_usage_types,
)


def test_projected_month_end():
    assert estimate_projected_month_end(50, 10, 30) == 150


def test_data_transfer_estimate_includes_free_tier():
    result = estimate_data_transfer_cost(80, 15, 30, 100, 0.09)
    assert result["projectedGb"] == 160
    assert result["remainingFreeGb"] == 20
    assert result["estimatedOverageGb"] == 60
    assert result["projectedMonthEndCostUsd"] == 5.4


def test_ec2_ebs_ipv4_logs_estimators():
    assert estimate_ec2_monthly_cost(0.02, 100, 10, 30) == 6
    assert estimate_ebs_cost(100, 0.08, 360) == 4
    assert estimate_public_ipv4_cost(2, 100, 0.005) == 1
    assert estimate_cloudwatch_logs_cost(10, 20, 0.5, 0.03) == 5.6


def test_traffic_classification():
    assert classify_traffic_path("/hero.mp4", "video/mp4", ".mp4", "Chrome") == "videos"
    assert classify_traffic_path("/banner.png", "image/png", ".png", "Chrome") == "images"
    assert classify_traffic_path("/api/rates", "application/json", "", "Chrome") == "API JSON"
    assert classify_traffic_path("/", "text/html", "", "Googlebot") == "bots/crawlers"
    assert classify_traffic_path("/_next/app.js", "application/javascript", ".js", "Chrome") == "JavaScript/CSS"


def test_aws_transfer_usage_type_classification():
    assert classify_aws_transfer_usage_type("DataTransfer-Out-Bytes") == TRANSFER_CATEGORY_INTERNET_EGRESS
    assert classify_aws_transfer_usage_type("APS1-DataTransfer-xAZ-Out-Bytes") == TRANSFER_CATEGORY_INTER_AZ
    assert classify_aws_transfer_usage_type("DataTransfer-In-Bytes") == TRANSFER_CATEGORY_INBOUND
    assert classify_aws_transfer_usage_type("NatGateway-Bytes") == TRANSFER_CATEGORY_NAT
    assert classify_aws_transfer_usage_type("S3-BytesDownloaded") == TRANSFER_CATEGORY_OTHER


def test_transfer_summary_only_counts_eligible_internet_out_toward_allowance():
    summary = summarize_transfer_usage_types(
        [
            {"name": "DataTransfer-Out-Bytes", "usageQuantity": 80, "cost": 7.2},
            {"name": "APS1-DataTransfer-xAZ-Out-Bytes", "usageQuantity": 50, "cost": 5.0},
            {"name": "DataTransfer-In-Bytes", "usageQuantity": 20, "cost": 0.0},
            {"name": "NatGateway-Bytes", "usageQuantity": 10, "cost": 1.1},
        ],
        elapsed_days=15,
        days_in_month=30,
        free_tier_gb=100,
        rate_per_gb=0.09,
    )

    assert summary["eligibleInternetTransferGb"] == 80
    assert summary["remainingFreeGb"] == 20
    assert summary["estimatedOverageGb"] == 60
    assert summary["projectedOverageUsd"] == 5.4
    assert summary["categories"][0]["label"] == "Internet transfer out"
