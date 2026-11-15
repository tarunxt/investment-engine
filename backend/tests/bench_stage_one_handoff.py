import json, resource, tempfile, time
from pathlib import Path
from app.domains.polymarket_auto_live import scan_source_store
from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data
resource.setrlimit(resource.RLIMIT_AS, (1800*1024*1024, 1800*1024*1024))
start = time.monotonic()
raw = {'id': 'source', 'question': 'Question', 'description': 'Original resolution rules. ' * 180}
encoded = encode_scan_export_data(raw)
with tempfile.TemporaryDirectory() as tmp:
    scan_source_store.SOURCE_ROOT = Path(tmp)
    rows = []
    with scan_source_store.ScanSourceWriter() as writer:
        for i in range(220000):
            rows.append(writer.store_rejected({
                'market_id': str(i), 'question_id': str(i), 'question': f'Market question {i}',
                'market_title': f'Market question {i}', 'slug': f'event-{i}',
                'market_url': f'https://polymarket.com/event/event-{i}',
                'theme': 'Politics', 'condition_id': f'condition-{i}',
                'current_yes_odds': 10, 'current_no_odds': 90,
                'volume_usd': 100, 'liquidity_usd': 200,
                'best_bid_cents': 10, 'best_ask_cents': 11, 'spread_cents': 1,
                'close_time': '2026-09-30T00:00:00Z',
                'force_include': False, 'force_included_position': False,
                'rules': raw['description'], 'event_description': raw['description'],
                'market_context': raw['description'], 'resolution_source': 'Official source',
                'preflight_evidence_block': raw['description'],
                'reasons': ['Failed configured volume threshold', 'Failed configured odds threshold'],
                'scan_export_data': encoded}))
    # Simulate the extra normalized-dictionary generation and JSON materialization
    # required by run persistence, while keeping the original scan rows resident.
    serialized = [dict(row) for row in rows]
    payload = json.dumps({'stage_results': [{'outputs': {'rejected_candidates': serialized}}]})
    print(json.dumps({'rows': len(rows), 'payload_bytes': len(payload),
                      'peak_rss_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
                      'seconds': round(time.monotonic()-start, 1)}), flush=True)
