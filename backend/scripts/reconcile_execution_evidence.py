"""Local-only execution evidence reconciliation; never calls a provider or broker."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domains.recommendation_audit.execution_evidence import reconcile_execution


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.input.stat().st_size > 20_000_000:
        parser.error("Offline input exceeds 20 MB bound")
    result = reconcile_execution(json.loads(args.input.read_text()))
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
