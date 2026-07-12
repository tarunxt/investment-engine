#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token"
IMDS_BASE_URL = "http://169.254.169.254/latest/meta-data"
IMDS_DYNAMIC_URL = "http://169.254.169.254/latest/dynamic/instance-identity/document"
READ_TIMEOUT_SECONDS = 3


@dataclass
class AwsContext:
    instance_id: str | None
    instance_type: str | None
    availability_zone: str | None
    region: str | None


def emit(line: str = "") -> None:
    print(line)


def emit_kv(key: str, value: Any) -> None:
    emit(f"{key}={value}")


def load_imds_token() -> str | None:
    request = Request(
        IMDS_TOKEN_URL,
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
    )
    try:
        with urlopen(request, timeout=READ_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError, OSError):
        return None


def imds_get(path: str, token: str | None) -> str | None:
    request = Request(f"{IMDS_BASE_URL}/{path}")
    if token:
        request.add_header("X-aws-ec2-metadata-token", token)
    try:
        with urlopen(request, timeout=READ_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8").strip()
    except (HTTPError, URLError, TimeoutError, OSError):
        return None


def imds_identity_document(token: str | None) -> dict[str, Any] | None:
    request = Request(IMDS_DYNAMIC_URL)
    if token:
        request.add_header("X-aws-ec2-metadata-token", token)
    try:
        with urlopen(request, timeout=READ_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def load_aws_context(explicit_region: str | None = None) -> AwsContext:
    token = load_imds_token()
    identity = imds_identity_document(token) or {}

    availability_zone = imds_get("placement/availability-zone", token) or identity.get(
        "availabilityZone"
    )
    region = explicit_region or identity.get("region") or os.getenv("AWS_REGION")
    if not region and availability_zone:
        region = availability_zone[:-1]

    return AwsContext(
        instance_id=imds_get("instance-id", token),
        instance_type=imds_get("instance-type", token),
        availability_zone=availability_zone,
        region=region,
    )


def build_client(service: str, region: str):
    try:
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore
    except Exception as exc:  # pragma: no cover - exercised in environments without boto3
        raise RuntimeError("boto3 is not available in this runtime") from exc

    return boto3.client(
        service,
        region_name=region,
        config=Config(connect_timeout=3, read_timeout=8, retries={"max_attempts": 2}),
    )


def permission_message(exc: Exception, fallback: str) -> str:
    try:
        from botocore.exceptions import ClientError, NoCredentialsError, PartialCredentialsError  # type: ignore
    except Exception:  # pragma: no cover - exercised in environments without boto3
        return fallback

    if isinstance(exc, (NoCredentialsError, PartialCredentialsError)):
        return "AWS credentials are not configured."
    if isinstance(exc, ClientError):
        error = exc.response.get("Error", {})
        code = str(error.get("Code") or "ClientError")
        message = str(error.get("Message") or code)
        if code in {
            "AccessDenied",
            "AccessDeniedException",
            "UnauthorizedOperation",
            "AuthFailure",
            "UnrecognizedClientException",
        }:
            return f"Missing permission or invalid credentials: {code} ({message})"
        return f"AWS API error: {code} ({message})"
    return fallback


def metric_summary(client: Any, instance_id: str, metric_name: str) -> dict[str, float] | None:
    end = datetime.now(UTC)
    start = end - timedelta(days=7)
    response = client.get_metric_statistics(
        Namespace="AWS/EC2",
        MetricName=metric_name,
        Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
        StartTime=start,
        EndTime=end,
        Period=3600,
        Statistics=["Average", "Maximum"],
    )
    datapoints = response.get("Datapoints", [])
    if not datapoints:
        return None

    averages = [float(point["Average"]) for point in datapoints if "Average" in point]
    maximums = [float(point["Maximum"]) for point in datapoints if "Maximum" in point]
    result: dict[str, float] = {}
    if averages:
        result["average"] = round(sum(averages) / len(averages), 2)
    if maximums:
        result["maximum"] = round(max(maximums), 2)
    return result or None


def emit_ec2_metrics(context: AwsContext, dry_run: bool) -> None:
    emit("== EC2 Instance ==")
    emit_kv("instance_id", context.instance_id or "not_available")
    emit_kv("instance_type", context.instance_type or "not_available")
    emit_kv("region", context.region or "not_available")
    emit_kv("availability_zone", context.availability_zone or "not_available")

    if dry_run:
        emit("CloudWatch CPU 7d: DRY RUN - would query CPUUtilization statistics.")
        emit("CloudWatch CPU credits: DRY RUN - would query CPUCreditBalance metrics for T families.")
        return

    if not context.instance_id or not context.region:
        emit("CloudWatch CPU 7d: unavailable - instance metadata or AWS region was not detected.")
        return

    try:
        cloudwatch = build_client("cloudwatch", context.region)
    except Exception as exc:
        emit(f"CloudWatch CPU 7d: unavailable - {exc}")
        return

    try:
        cpu = metric_summary(cloudwatch, context.instance_id, "CPUUtilization")
        if not cpu:
            emit("CloudWatch CPU 7d: no datapoints returned.")
        else:
            emit(
                "CloudWatch CPU 7d: "
                f"average={cpu.get('average', 'n/a')}% "
                f"max={cpu.get('maximum', 'n/a')}%"
            )
    except Exception as exc:
        emit(
            "CloudWatch CPU 7d: "
            + permission_message(exc, "Unable to read cloudwatch:GetMetricStatistics.")
        )

    if not (context.instance_type or "").startswith("t"):
        emit("CloudWatch CPU credits: not applicable for non-T instance families.")
        return

    credit_metrics = {
        "CPUCreditBalance": "balance",
        "CPUSurplusCreditBalance": "surplus_balance",
        "CPUSurplusCreditsCharged": "surplus_charged",
    }
    credit_parts: list[str] = []
    try:
        for metric_name, label in credit_metrics.items():
            stats = metric_summary(cloudwatch, context.instance_id, metric_name)
            if not stats:
                credit_parts.append(f"{label}=no_data")
                continue
            if "maximum" in stats:
                credit_parts.append(f"{label}_max={stats['maximum']}")
            if "average" in stats:
                credit_parts.append(f"{label}_avg={stats['average']}")
        emit("CloudWatch CPU credits: " + ", ".join(credit_parts))
    except Exception as exc:
        emit(
            "CloudWatch CPU credits: "
            + permission_message(exc, "Unable to read EC2 CPU credit metrics.")
        )


def paginate(
    method: Callable[..., dict[str, Any]],
    result_key: str,
    request_token_key: str = "pageToken",
    response_token_key: str = "nextPageToken",
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    next_page_token: str | None = None

    while True:
        kwargs = {request_token_key: next_page_token} if next_page_token else {}
        response = method(**kwargs)
        items.extend(response.get(result_key, []))
        next_page_token = response.get(response_token_key)
        if not next_page_token:
            return items


def emit_lightsail_inventory(region: str | None, dry_run: bool) -> None:
    emit("== Lightsail Inventory ==")
    emit_kv("region", region or "not_available")

    if dry_run:
        emit("Lightsail API: DRY RUN - would query instances, static IPs, disks, and snapshots.")
        return

    if not region:
        emit("Lightsail API: unavailable - AWS region was not detected.")
        return

    try:
        lightsail = build_client("lightsail", region)
    except Exception as exc:
        emit(f"Lightsail API: unavailable - {exc}")
        return

    collections: list[tuple[str, str, Callable[[], list[dict[str, Any]]]]] = [
        ("instances", "get_instances", lambda: paginate(lightsail.get_instances, "instances")),
        ("static_ips", "get_static_ips", lambda: paginate(lightsail.get_static_ips, "staticIps")),
        ("disks", "get_disks", lambda: paginate(lightsail.get_disks, "disks")),
        (
            "instance_snapshots",
            "get_instance_snapshots",
            lambda: paginate(lightsail.get_instance_snapshots, "instanceSnapshots"),
        ),
        (
            "disk_snapshots",
            "get_disk_snapshots",
            lambda: paginate(lightsail.get_disk_snapshots, "diskSnapshots"),
        ),
    ]

    for label, permission_hint, loader in collections:
        try:
            items = loader()
            emit(f"{label}: count={len(items)}")
            for item in items[:10]:
                name = item.get("name") or item.get("instanceName") or item.get("resourceType") or "unknown"
                state = item.get("state")
                state_name = state.get("name") if isinstance(state, dict) else state
                blueprint = item.get("blueprintName") or item.get("bundleId") or item.get("supportCode") or ""
                attachment = item.get("attachedTo") or item.get("ipAddress") or item.get("fromAttachedDisks") or ""
                emit(
                    f"  - name={name} state={state_name or 'n/a'} "
                    f"details={blueprint or attachment or 'n/a'}"
                )
            if len(items) > 10:
                emit(f"  - ... {len(items) - 10} more")
        except Exception as exc:
            message = permission_message(exc, f"Unable to read lightsail:{permission_hint}.")
            emit(f"{label}: {message}")


def emit_ec2_rightsize_signal(context: AwsContext, dry_run: bool) -> None:
    emit_ec2_metrics(context, dry_run)
    if dry_run:
        emit("Right-size signal: DRY RUN - would derive an underutilization hint from CPU data.")
        return

    if not context.instance_id or not context.region:
        emit("Right-size signal: unavailable - missing EC2 instance metadata.")
        return

    try:
        cloudwatch = build_client("cloudwatch", context.region)
        cpu = metric_summary(cloudwatch, context.instance_id, "CPUUtilization")
    except Exception as exc:
        emit(
            "Right-size signal: "
            + permission_message(exc, "Unable to read cloudwatch:GetMetricStatistics.")
        )
        return

    if not cpu:
        emit("Right-size signal: not enough data.")
        return

    average = cpu.get("average", 0.0)
    maximum = cpu.get("maximum", 0.0)
    if average <= 15 and maximum <= 45:
        emit("Right-size signal: underutilized candidate based on 7-day CPU average/max.")
    elif average >= 65 or maximum >= 85:
        emit("Right-size signal: busy instance - avoid downsizing without deeper review.")
    else:
        emit("Right-size signal: mixed usage - gather memory/app metrics before changing size.")


def render_dry_run_examples(region: str | None) -> None:
    emit("Dry run example:")
    emit(
        "  python deploy/no-docker/scripts/aws-readonly-report.py "
        f"--region {region or 'ap-south-1'} runtime-resource --dry-run"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only AWS runtime diagnostics.")
    parser.add_argument("--region", default=None, help="AWS region override.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("runtime-resource", "ec2-rightsize", "lightsail-inventory"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    context = load_aws_context(args.region)

    if args.command == "runtime-resource":
        emit_ec2_metrics(context, args.dry_run)
        if args.dry_run:
            render_dry_run_examples(context.region)
        return 0

    if args.command == "ec2-rightsize":
        emit_ec2_rightsize_signal(context, args.dry_run)
        if args.dry_run:
            render_dry_run_examples(context.region)
        return 0

    if args.command == "lightsail-inventory":
        emit_lightsail_inventory(context.region, args.dry_run)
        if args.dry_run:
            render_dry_run_examples(context.region)
        return 0

    print(f"Unknown command: {args.command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
