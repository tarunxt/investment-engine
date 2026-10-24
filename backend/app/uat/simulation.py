"""Bounded deterministic synthetic adapters, with no network or file I/O.

These are independent UAT components, not registered in production factories.
Runtime wiring and network isolation remain mandatory before activation.
"""
from dataclasses import dataclass
import hashlib
import json
import re


@dataclass(frozen=True)
class SyntheticOrder:
    order_id: str
    symbol: str
    side: str
    quantity: int
    price: str
    simulation: bool = True


class SyntheticBroker:
    def __init__(self, config):
        # Exact key set prevents accidentally supplying a real endpoint, token,
        # account, or adapter selection. Never include config values in errors.
        if config != {'environment': 'uat', 'adapter': 'synthetic-v1'}:
            raise ValueError('Only isolated synthetic configuration is supported')
        self._orders = {}

    def submit(self, *, request_id, symbol, side, quantity):
        if (not isinstance(request_id, str)
                or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', request_id)
                or symbol != 'SYNTHETIC-INDEX' or side not in ('buy', 'sell')
                or type(quantity) is not int or not 1 <= quantity <= 100):
            raise ValueError('Unsupported synthetic order')
        payload = (symbol, side, quantity)
        if request_id in self._orders:
            prior_payload, order = self._orders[request_id]
            if prior_payload != payload:
                raise ValueError('Synthetic request ID conflict')
            return order
        if len(self._orders) >= 1000:
            raise ValueError('Synthetic order capacity reached')
        digest = hashlib.sha256(json.dumps([request_id, *payload]).encode()).hexdigest()[:24]
        order = SyntheticOrder('synthetic-' + digest, symbol, side, quantity, '100.00')
        self._orders[request_id] = (payload, order)
        return order


def synthetic_ai(prompt):
    if not isinstance(prompt, str) or len(prompt) > 4096:
        raise ValueError('Invalid synthetic prompt')
    return {'content': 'Synthetic fixture: no investment recommendation.',
            'tokens_in': 0, 'tokens_out': 0, 'cost': 0,
            'provider': 'synthetic', 'model': 'fixture-v1', 'simulation': True}


class SyntheticEmailSink:
    def __init__(self):
        self.count = 0

    def send(self, recipient, subject, body):
        if any(not isinstance(x, str) or len(x) > 4096 for x in (recipient, subject, body)):
            raise ValueError('Invalid synthetic email')
        if self.count >= 1000:
            raise ValueError('Synthetic email capacity reached')
        self.count += 1
        # Do not retain or transmit message contents or recipient details.
        return {'simulation': True, 'delivered': False, 'sink_sequence': self.count}
