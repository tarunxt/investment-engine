"""Pure deterministic adapters; no network clients, broker SDKs or credentials."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

STAMP = '2026-10-19T00:00:00+00:00'
HOLDINGS = [
    {'tradingsymbol': 'UATTECH', 'exchange': 'NSE', 'isin': 'UAT000000001',
     'quantity': 10, 'average_price': 100.0, 'last_price': 110.0,
     'close_price': 108.0, 'pnl': 100.0, 'day_change': 2.0, 'day_change_percentage': 1.85},
    {'tradingsymbol': 'UATBANK', 'exchange': 'NSE', 'isin': 'UAT000000002',
     'quantity': 20, 'average_price': 50.0, 'last_price': 48.0,
     'close_price': 49.0, 'pnl': -40.0, 'day_change': -1.0, 'day_change_percentage': -2.04},
]


class FakeBroker:
    def portfolio(self, empty=False):
        if empty:
            return {'latest': None, 'history': []}
        summary = dict(snapshot_date=STAMP[:10], captured_at=STAMP, source='uat2_synthetic',
                       holdings_count=2, net_positions_count=0, day_positions_count=0,
                       holdings_market_value=2060, holdings_invested_value=2000,
                       holdings_pnl=60, holdings_day_change_value=0, available_margin=500,
                       positions_pnl=0, positions_m2m=0)
        holdings = [dict(h, market_value=h['quantity']*h['last_price'],
                         invested_value=h['quantity']*h['average_price'],
                         day_change_value=h['quantity']*h['day_change']) for h in HOLDINGS]
        return {'latest': dict(summary, holdings=holdings, positions={'net': [], 'day': []}),
                'history': [summary]}

    def place(self, order):
        payload = json.dumps(order, sort_keys=True, separators=(',', ':'))
        return {'order_id': 'SIM-' + hashlib.sha256(payload.encode()).hexdigest()[:16],
                'variety': 'regular', 'market_open': True, 'auto_converted_to_amo': False}


class FakeAI:
    def generate(self, prompt):
        return {'content': json.dumps({'simulation': True, 'decision': 'HOLD',
                                      'input_digest': hashlib.sha256(prompt.encode()).hexdigest()}),
                'tokens_in': 0, 'tokens_out': 0, 'cost': 0, 'provider': 'uat2_fake',
                'model': 'deterministic-v1'}


class EmailSink:
    def __init__(self, directory):
        self.directory = Path(directory)

    def send(self, subject, body):
        self.directory.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({'subject': subject, 'body': body, 'simulation': True})
        name = hashlib.sha256(payload.encode()).hexdigest() + '.json'
        (self.directory / name).write_text(payload)
        return {'status': 'captured', 'artifact': name}
