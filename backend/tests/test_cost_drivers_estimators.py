from app.domains.cost_drivers.estimators import (
    classify_traffic_path,
    estimate_cloudwatch_logs_cost,
    estimate_data_transfer_cost,
    estimate_ebs_cost,
    estimate_ec2_monthly_cost,
    estimate_projected_month_end,
    estimate_public_ipv4_cost,
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
