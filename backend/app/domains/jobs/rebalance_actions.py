"""Decision labels from the Rebalance provider contract and saved scoring outputs."""
import json
import re
from pathlib import Path

# Buy New is the only purchase label for a new position in the provider contract.
PROVIDER_ACTIONS = json.loads(Path(__file__).with_suffix(".json").read_text())
_SCORE_ACTIONS = {
    **{label.lower(): action for label, action in PROVIDER_ACTIONS.items()},
    "sell": "Sell All", "exit": "Sell All", "reduce": "Trim",
    "new buy": "Buy New", "new": "Buy New", "buy more": "Add more",
}


def normalize_action(value):
    label = re.sub(r"[\s_-]+", " ", str(value or "").lower()).strip()
    return _SCORE_ACTIONS.get(label)
