"""Offline CLI: python scripts/replay_recommendations.py input.json output.json."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domains.recommendation_audit.evaluation import replay, sensitivity, walk_forward
from app.domains.recommendation_audit.validation import validation_report


def atomic_report(path, report):
    """Publish a complete JSON report or preserve the previous output bytes."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as target:
            temporary = Path(target.name)
            json.dump(report, target, indent=2, allow_nan=False)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Replay frozen recommendation evidence without APIs")
    parser.add_argument("input", type=Path); parser.add_argument("output", type=Path)
    parser.add_argument("--evidence-only", action="store_true", help="Inventory only; no replay or toy simulation")
    args = parser.parse_args()
    try:
        if args.input.resolve() == args.output.resolve():
            raise ValueError("Source and output must differ")
        if args.input.stat().st_size > 20_000_000:
            raise ValueError("Offline input exceeds byte bound")
        data = json.loads(args.input.read_text())
        if not isinstance(data, dict):
            raise ValueError("Expected JSON object")
        records = data["records"]
        if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
            raise ValueError("Expected record objects")
        if not isinstance(data.get("prices", []), list):
            raise ValueError("Expected price array")
        for record in records:
            for key in ("coverage", "calculation", "execution_costs"):
                if record.get(key) is not None and not isinstance(record[key], dict):
                    raise ValueError("Invalid nested evidence object")
            findings = (record.get("calculation") or {}).get("findings", [])
            if not isinstance(findings, list) or any(not isinstance(finding, dict) for finding in findings):
                raise ValueError("Invalid captured findings")
        if len(records) > 10000 or len(data.get("prices", [])) > 100000:
            raise ValueError("Offline dataset exceeds bounds")
        report = {"validation": validation_report(data), "robustness_established": False}
        if not args.evidence_only:
            report.update(dataset_provenance=data.get("provenance", "unspecified"), replay=replay(records),
                          sensitivity=[{"id": r.get("id"), **sensitivity(r)} for r in records],
                          walk_forward=walk_forward(records, data.get("prices", []), **data.get("simulation", {})))
        atomic_report(args.output, report)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Report the error layer without leaking source records or validation values.
        parser.exit(2, f"Offline evidence processing failed ({type(error).__name__}). No new report was published; any existing output is unchanged.\n")


if __name__ == "__main__": main()
