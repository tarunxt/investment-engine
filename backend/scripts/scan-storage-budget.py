#!/usr/bin/env python3
"""Internal local frontend adapter for the exact backend reservation protocol.
One JSON request on stdin; no network, credentials, retention or deletion actions.
"""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domains.trading_bots.storage_budget import StorageBudget


def main():
    request = json.load(sys.stdin)
    budget = StorageBudget(Path(request['root']), identity=request['identity'], token=request['token'])
    action = request['action']
    if action == 'reserve':
        budget.reserve_many([(Path(item['target']), item['bytes']) for item in request['requests']])
    elif action == 'consume':
        budget.consume(Path(request['target']), request['bytes'])
    elif action == 'release':
        budget.release()
    elif action == 'snapshot':
        print(json.dumps(budget.snapshot()))
        return
    else:
        raise ValueError('Unsupported reservation action')
    print(json.dumps({'ok': True}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(1)
