from __future__ import annotations

import os
from pathlib import Path


def get_polymarket_auto_live_data_dir() -> Path:
    return Path(
        os.getenv("POLYMARKET_AUTO_LIVE_DATA_DIR", "data/polymarket-auto-live")
    ).expanduser()
