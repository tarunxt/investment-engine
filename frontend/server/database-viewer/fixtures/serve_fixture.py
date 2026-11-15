"""Synthetic offline UI fixture only; never include this file in the service artifact."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from browser import make_app
from test_http import FakeStore
import uvicorn

uvicorn.run(make_app(FakeStore()), uds=sys.argv[1], access_log=False, log_level='error')
