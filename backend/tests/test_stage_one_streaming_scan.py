"""Exercise pagination, source preservation and the production serialization adapter."""
import ast
import asyncio
from pathlib import Path
import pytest
from app.domains.polymarket_auto_live import scanner, scan_source_store
from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data, decode_scan_export_data


def serializers():
    # Load the real pure adapters without bootstrapping DB/provider infrastructure.
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/engine.py'
    tree = ast.parse(path.read_text())
    names = {'_serialize_scan_candidate', '_serialize_rejected_scan_candidate'}
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    ns = {'ScannedMarket': scanner.ScannedMarket, 'ScanRejectedMarket': scanner.ScanRejectedMarket,
          'encode_scan_export_data': encode_scan_export_data}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    return ns['_serialize_rejected_scan_candidate']


def row(identity):
    return {'id': identity, 'question': 'Will this happen?', 'slug': identity,
            'outcomes': '["Yes", "No"]', 'outcomePrices': '["0.1", "0.9"]',
            'description': 'Source rules ' * 1000, 'volume': 1234,
            '_export_event': {'id': 'parent', 'extra': {'zero': 0, 'false': False}}}


@pytest.mark.asyncio
async def test_streamed_rejections_release_raw_before_next_page_and_keep_export(monkeypatch, tmp_path):
    monkeypatch.setattr(scan_source_store, 'SOURCE_ROOT', tmp_path)
    serialize = serializers()
    saved = []
    calls = 0
    async def fetch(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return [row('reject')], 'second'
        assert saved[0].source_market is None
        assert len(saved[0].serialized_candidate['scan_export_data']) < 160
        return [row('accept'), row('reject')], None
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    with scan_source_store.ScanSourceWriter() as writer:
        def persist(rejected):
            rejected.serialized_candidate = writer.store(serialize(rejected))
            rejected.source_market = None
            saved.append(rejected)
        result = await scanner.scan_candidate_markets(
            min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True,
            market_filter=lambda market: ['test reason'] if market.market_id == 'reject' else [],
            rejected_callback=persist)
    assert result.complete_universe
    assert [m.market_id for m in result.accepted] == ['accept']
    assert len(result.rejected) == 1
    actual = serialize(result.rejected[0])
    assert actual['reasons'] == ['test reason']
    assert actual['volume_usd'] == 1234
    assert decode_scan_export_data(actual) == decode_scan_export_data({'scan_export_data': encode_scan_export_data(row('reject'))})
    assert result.accepted[0].raw == row('accept')


@pytest.mark.asyncio
async def test_total_page_deadline_preserves_pages_and_marks_incomplete(monkeypatch):
    calls = 0
    async def fetch(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return [row('first')], 'second'
        await asyncio.Event().wait()
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    progress = []
    result = await asyncio.wait_for(scanner.scan_candidate_markets(
        min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True,
        preserve_partial_on_error=True, pagination_deadline_seconds=0.3,
        progress_callback=lambda *p: progress.append(p)), timeout=2)
    assert not result.complete_universe
    assert result.warning
    assert [m.market_id for m in result.accepted] == ['first']
    assert progress == [(1, 1)]


@pytest.mark.asyncio
async def test_source_write_failure_cannot_report_complete_scan(monkeypatch):
    async def fetch(*args, **kwargs):
        return [row('reject')], None
    def fail(_):
        raise OSError('source pack unavailable')
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    with pytest.raises(OSError, match='source pack unavailable'):
        await scanner.scan_candidate_markets(
            min_liquidity_usd=0, use_keyset_pagination=True,
            market_filter=lambda _: ['rejected'], rejected_callback=fail)


@pytest.mark.asyncio
@pytest.mark.parametrize('streaming', [False, True])
async def test_console_applies_saved_filters_once_per_market(monkeypatch, streaming):
    from datetime import UTC, datetime
    from types import SimpleNamespace
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/console_profile.py'
    tree = ast.parse(path.read_text())
    func = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'scan_console_profile_markets')
    ns = dict(vars(scanner))
    # Defaults and constants come from the production file; integrations are faked.
    for node in tree.body:
        if isinstance(node, ast.Assign):
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, TypeError):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    ns[target.id] = value
    async def no_cli(*args, **kwargs):
        raise RuntimeError('CLI unavailable')
    async def fetch(*args, **kwargs):
        return [row('reject'), row('accept')], None
    checked = []
    def filters(market, **kwargs):
        assert kwargs['min_volume_usd'] == 777
        assert kwargs['exclude_weather'] is False
        checked.append(market.market_id)
        return ['saved filter'] if market.market_id == 'reject' else []
    ns.update(run_first_bullpen_json=no_cli, console_market_filter_reasons=filters,
              ConsoleScanResult=lambda **kw: SimpleNamespace(**kw), redact_secrets=lambda v: v)
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), func], type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), 'exec'), ns)
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    saved = []
    result = await ns['scan_console_profile_markets'](
        now=datetime.now(UTC), scan_scope='full_universe', min_volume_usd=777,
        exclude_weather=False, rejected_callback=saved.append if streaming else None)
    assert checked == ['reject', 'accept']
    assert result.total_candidates == result.catalogue_candidates == 2
    assert result.complete_universe
    assert len(result.accepted) == len(result.rejected) == 1
    assert len(saved) == int(streaming)


@pytest.mark.asyncio
async def test_full_universe_continues_after_old_five_minute_cutoff(monkeypatch):
    from types import SimpleNamespace
    elapsed = 0
    cursors = []
    async def fetch(*args, **kwargs):
        nonlocal elapsed
        cursors.append(kwargs['after_cursor'])
        elapsed += 301
        return [row(str(elapsed))], 'next' if len(cursors) == 1 else None
    monkeypatch.setattr(scanner, 'time', SimpleNamespace(monotonic=lambda: elapsed))
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    result = await scanner.scan_candidate_markets(
        min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True,
        pagination_deadline_seconds=5400, preserve_partial_on_error=True)
    assert cursors == [None, 'next']
    assert result.complete_universe
    assert len(result.accepted) == 2


@pytest.mark.asyncio
async def test_transient_keyset_failure_retries_same_cursor_without_duplicate_rows(monkeypatch):
    import httpx
    cursors = []
    async def fetch(*args, **kwargs):
        cursors.append(kwargs['after_cursor'])
        if len(cursors) == 1:
            return [row('first')], 'next'
        if len(cursors) == 2:
            request = httpx.Request('GET', scanner.POLYMARKET_GAMMA_EVENTS_KEYSET_URL)
            raise httpx.HTTPStatusError('busy', request=request, response=httpx.Response(503, request=request))
        return [row('first'), row('second')], None
    async def no_sleep(_):
        pass
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    monkeypatch.setattr(scanner.asyncio, 'sleep', no_sleep)
    result = await scanner.scan_candidate_markets(
        min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True)
    assert cursors == [None, 'next', 'next']
    assert result.complete_universe
    assert [m.market_id for m in result.accepted] == ['first', 'second']


@pytest.mark.asyncio
async def test_exhausted_transient_retries_preserve_incomplete_results(monkeypatch):
    import httpx
    calls = 0
    async def fetch(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return [row('first')], 'next'
        raise httpx.ReadTimeout('upstream timeout')
    async def no_sleep(_):
        pass
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    monkeypatch.setattr(scanner.asyncio, 'sleep', no_sleep)
    result = await scanner.scan_candidate_markets(
        min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True,
        preserve_partial_on_error=True)
    assert calls == 4
    assert not result.complete_universe
    assert len(result.accepted) == 1
    assert result.details == 'upstream timeout'


@pytest.mark.parametrize('volume', [0, 123.45])
def test_gamma_daily_volume_reaches_saved_filter(volume):
    market = scanner._normalize_market({**row('volume'), 'volume24hr': volume})
    assert market.volume_24hr_usd == volume
