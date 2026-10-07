"""Offline CLI: python scripts/replay_recommendations.py input.json output.json."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domains.recommendation_audit.evaluation import replay, sensitivity, walk_forward


def main():
    parser = argparse.ArgumentParser(description="Replay frozen recommendation evidence without APIs")
    parser.add_argument("input", type=Path); parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    records = data["records"]
    if len(records) > 10000 or len(data.get("prices", [])) > 100000: raise ValueError("Offline dataset exceeds bounds")
    report = {"dataset_provenance": data.get("provenance", "unspecified"), "replay": replay(records), "sensitivity": [{"id": r.get("id"), **sensitivity(r)} for r in records], "walk_forward": walk_forward(records, data.get("prices", []), **data.get("simulation", {})), "robustness_established": False}
    args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__": main()
