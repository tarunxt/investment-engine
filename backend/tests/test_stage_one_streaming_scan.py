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

@pytest.mark.parametrize('completeness', ['partial', 'complete'])
def test_console_projections_preserve_scan_completion_evidence(completeness):
    from typing import Any, Iterable
    from types import SimpleNamespace
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/console_projection.py'
    tree = ast.parse(path.read_text())
    functions = {'_bounded_value', '_select_keys', '_compact_stage', 'build_minimal_workflow_stage_results'}
    nodes = [n for n in tree.body if
             (isinstance(n, ast.FunctionDef) and n.name in functions) or
             (isinstance(n, ast.Assign) and all(isinstance(t, ast.Name) and t.id.startswith('_') for t in n.targets))]
    class Stage(SimpleNamespace):
        def model_dump(self, **kwargs):
            return vars(self).copy()
        def model_copy(self, update):
            return Stage(**(vars(self) | update))
    ns = {'Any': Any, 'Iterable': Iterable, 'BullpenAutoLiveStageResult': Stage,
          'canonical_workflow_stage_results': lambda stages: stages,
          'workflow_stage_key': lambda stage: 'scan'}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    evidence = dict(scan_scope='full_universe', scan_completeness=completeness,
                    scan_warning='Warning ' * 200, scan_details='Cursor status')
    stage = Stage(inputs={}, outputs=evidence | {'scan_export_data': 'large raw payload'}, guardrails_checked=[])
    for outputs in (ns['_compact_stage'](stage)['outputs'],
                    ns['build_minimal_workflow_stage_results']([stage])[0].outputs):
        assert outputs['scan_scope'] == 'full_universe'
        assert outputs['scan_completeness'] == completeness
        assert outputs['scan_details'] == 'Cursor status'
        assert outputs['scan_warning'].startswith('Warning ')
        assert len(outputs['scan_warning']) <= ns['_MAX_STRING_LENGTH'] + 1
        assert 'scan_export_data' not in outputs

@pytest.mark.asyncio
async def test_passed_markets_spool_nested_payloads_and_keep_exact_excel_source(monkeypatch, tmp_path):
    from app.domains.polymarket_auto_live.scan_source_store import restore_market_raw
    monkeypatch.setattr(scan_source_store, 'SOURCE_ROOT', tmp_path / 'sources')
    original = row('accepted')
    original['conditionId'] = 'condition-123'
    original['_export_event']['metadata'] = {'large': ['x' * 1000] * 1000}
    async def fetch(*args, **kwargs):
        return [original], None
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', fetch)
    with scan_source_store.ScanSourceWriter() as writer:
        result = await scanner.scan_candidate_markets(
            min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True,
            accepted_callback=writer.store_market)
    market = result.accepted[0]
    assert market.raw['conditionId'] == 'condition-123'
    assert all(not isinstance(value, (list, dict)) for value in market.raw.values())
    expected = decode_scan_export_data({'scan_export_data': encode_scan_export_data(original)})
    actual = decode_scan_export_data({'scan_export_data': market.raw['_scan_export_data']})
    assert actual == expected
    assert restore_market_raw(market)['_export_event'] == expected['event']
    # Exercise the production serializer, including its stored-reference path.
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/engine.py'
    node = next(n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == '_serialize_scan_candidate')
    ns = {'ScannedMarket': scanner.ScannedMarket, 'encode_scan_export_data': encode_scan_export_data}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), ns)
    assert decode_scan_export_data(ns['_serialize_scan_candidate'](market)) == expected


@pytest.mark.asyncio
async def test_worker_redelivery_replays_saved_pages_then_continues_cursor(monkeypatch, tmp_path):
    monkeypatch.setattr(scan_source_store, 'SOURCE_ROOT', tmp_path / 'sources')
    calls = []
    async def crash_after_first_page(client, *, after_cursor=None, **kwargs):
        calls.append(after_cursor)
        if after_cursor is None:
            return [row('first')], 'next'
        raise asyncio.CancelledError()
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', crash_after_first_page)
    options = dict(min_liquidity_usd=0, apply_base_filters=False, use_keyset_pagination=True,
                   page_cache_key='run-123', filter_parent_deadlines=False)
    with pytest.raises(asyncio.CancelledError):
        await scanner.scan_candidate_markets(**options)
    assert calls == [None, 'next']
    calls.clear()
    async def finish(client, *, after_cursor=None, **kwargs):
        calls.append(after_cursor)
        assert after_cursor == 'next'
        return [row('first'), row('last')], None
    monkeypatch.setattr(scanner, '_fetch_gamma_keyset_page', finish)
    result = await scanner.scan_candidate_markets(**options)
    assert calls == ['next']
    assert result.complete_universe
    assert [m.market_id for m in result.accepted] == ['first', 'last']
    calls.clear()
    replay = await scanner.scan_candidate_markets(**options, market_filter=lambda m: ['new filter'])
    assert calls == []
    assert replay.complete_universe and len(replay.rejected) == 2


def test_page_cache_isolates_runs_and_ignores_torn_writes(monkeypatch, tmp_path):
    from app.domains.polymarket_auto_live.scan_page_cache import ScanPageCache
    monkeypatch.setattr(scan_source_store, 'SOURCE_ROOT', tmp_path / 'sources')
    first, second = ScanPageCache('run1'), ScanPageCache('run2')
    first.write(None, None, [row('one')], 'next')
    assert first.read(None, None)[1] == 'next'
    assert second.read(None, None) is None
    assert first.read(None, 'different-query') is None
    first.path(None, None).write_bytes(b'broken gzip')
    assert first.read(None, None) is None


def test_rejected_text_storage_preserves_every_excel_cell_and_legacy_sources(monkeypatch, tmp_path):
    import json
    from app.domains.polymarket_auto_live.stage_one_excel import _row_values, _export_headers, build_stage_one_excel
    from types import SimpleNamespace
    monkeypatch.setattr(scan_source_store, 'SOURCE_ROOT', tmp_path / 'sources')
    raw = row('reject-text')
    raw['description'] = 'Original rules ' * 250
    original = serializers()(scanner.ScanRejectedMarket(
        'reject-text', 'Question', 'reject-text', None, ['rule A', 'rule B'],
        source_market=scanner._normalize_market(raw)))
    original.update(market_context='Exact normalized context ' * 200,
                    resolution_source='Exact normalized source',
                    preflight_evidence_block='Exact evidence ' * 200)
    headers = _export_headers([original])
    expected = _row_values(original, 1, 'filtered', headers)
    with scan_source_store.ScanSourceWriter() as writer:
        compact = writer.store_rejected(original)
    assert original['rules']  # No mutation of the caller's evidence.
    assert compact['rules'] is None and compact['event_description'] is None
    assert compact['scan_text_storage_version'] == 1
    assert compact['reasons'] == original['reasons']
    assert _row_values(compact, 1, 'filtered', headers) == expected
    assert _export_headers([compact]) == headers
    assert len(json.dumps(compact)) < len(json.dumps(original)) / 3
    source = decode_scan_export_data(compact)
    assert source['market'] == decode_scan_export_data(original)['market']
    assert source['candidate_text_fields_v1']['rules'] == original['rules']
    run = SimpleNamespace(stage_results=[SimpleNamespace(stage_number=1, outputs={
        'workflow_stage_key': 'scan', 'scanned_candidates': 1,
        'accepted_candidates': [], 'rejected_candidates': [compact]})],
        started_at='2026-09-07T00:00:00+00:00', completed_at=None)
    path, _, count = build_stage_one_excel(run)
    try:
        import zipfile
        with zipfile.ZipFile(path) as workbook:
            xml = workbook.read('xl/worksheets/sheet1.xml').decode()
            assert original['rules'] in xml
            assert original['market_context'] in xml
            assert original['preflight_evidence_block'] in xml
        assert count == 1
    finally:
        path.unlink()


def test_export_enrichment_preserves_externalized_normalized_text(monkeypatch, tmp_path):
    import httpx
    from app.domains.polymarket_auto_live import stage_one_export_enrichment as enrichment
    from app.domains.polymarket_auto_live.stage_one_excel import _source_fallbacks
    monkeypatch.setattr(scan_source_store, 'SOURCE_ROOT', tmp_path / 'sources')
    raw = row('missing-volume')
    del raw['volume']
    with scan_source_store.ScanSourceWriter() as writer:
        compact = writer.store_rejected({'market_id': 'missing-volume',
            'rules': 'Frozen normalized rules', 'scan_export_data': encode_scan_export_data(raw)})
    response = {'events': [{'id': 'event', 'description': 'Current description',
        'markets': [{'id': 'missing-volume', 'volume': 100, 'outcomes': ['Yes', 'No'],
                     'description': 'Current market description'}]}], 'next_cursor': None}
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response)))
    monkeypatch.setattr(enrichment.httpx, 'Client', lambda **kwargs: client)
    enrichment.enrich_export_rows([compact])
    source = decode_scan_export_data(compact)
    assert source['market']['volume'] == 100
    assert source['candidate_text_fields_v1']['rules'] == 'Frozen normalized rules'
    assert _source_fallbacks(compact, source)['rules'] == 'Frozen normalized rules'
