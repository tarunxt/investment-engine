import json
import pytest
from app.domains.jobs.technical_prices import validate_technical_prices

PROMPT = '[TECHNICAL_PRICE_ANCHORS_V1]\n' + json.dumps([
    {'instrument':'NSE:LAURUSLABS','price':620,'as_of':'2026-10-29T09:17:00Z'},
]) + '\n[/TECHNICAL_PRICE_ANCHORS_V1]'

def table(exchange='NSE', trigger='640', stop='590'):
    return f'| Exchange Symbol | Stock Symbol | Trigger Level | Invalidation Level |\n|---|---|---|---|\n| {exchange} | LAURUSLABS | {trigger} | {stop} |'

def test_accepts_exact_venue_reconciled_prices():
    validate_technical_prices(PROMPT, table())

@pytest.mark.parametrize('content', [table(trigger='918'), table(exchange='BSE'), table(trigger='about 640'), table(stop='0'), table()+'\n| NSE | LAURUSLABS | 640 | 590 |', 'No data'])
def test_rejects_cross_scale_missing_duplicate_or_wrong_venue(content):
    with pytest.raises(ValueError): validate_technical_prices(PROMPT, content)

def test_legacy_is_not_rewritten():
    validate_technical_prices('Old custom prompt', table(trigger='918'))


def test_repair_keeps_valid_venue_and_requests_only_missing_venue():
    from app.domains.jobs.technical_prices import (
        MissingTechnicalListings, merge_technical_rows, missing_listing_prompt,
    )
    anchors = [{'instrument': f'{venue}:LAURUSLABS', 'price': 620} for venue in ('NSE', 'BSE')]
    prompt = '[TECHNICAL_PRICE_ANCHORS_V1]' + json.dumps(anchors) + '[/TECHNICAL_PRICE_ANCHORS_V1]'
    with pytest.raises(MissingTechnicalListings, match='BSE:LAURUSLABS') as error:
        validate_technical_prices(prompt, table())
    repair = missing_listing_prompt(prompt, error.value.ids)
    assert 'NSE:LAURUSLABS' not in repair
    with pytest.raises(ValueError, match='unexpected'):
        validate_technical_prices(repair, table())
    supplement = table(exchange='BSE')
    validate_technical_prices(repair, supplement)
    merged = merge_technical_rows(table(), supplement)
    assert merged.count('Exchange Symbol') == 1
    validate_technical_prices(prompt, merged)


def test_bel_trigger_is_separate_from_support_and_invalidation():
    from app.domains.jobs.technical_prices import normalize_technical_rows
    prompt = PROMPT.replace('LAURUSLABS', 'BEL').replace('620', '395.9')
    source = table(trigger='Reclaim above 400 after higher low holds at 382', stop='Close below 378').replace('LAURUSLABS', 'BEL')
    evidence = []
    result, excluded = normalize_technical_rows(prompt, source, evidence)
    assert not excluded
    assert '| NSE | BEL | 400 | 378 |' in result
    assert evidence[0]['original'] == 'Reclaim above 400 after higher low holds at 382'
    assert evidence[0]['price'] == '400'
    validate_technical_prices(prompt, result)
    assert normalize_technical_rows(prompt, result, []) == (result, set())


@pytest.mark.parametrize('raw', ['620 or 640 EMA', '400–840', '620 or $640', 'above 5%', '20 EMA', 'below 2000', '$620'])
def test_excludes_only_the_unusable_listing(raw):
    from app.domains.jobs.technical_prices import MissingTechnicalListings, normalize_technical_rows
    prompt = '[TECHNICAL_PRICE_ANCHORS_V1]' + json.dumps([
        {'instrument': 'NSE:ONE', 'price': 620}, {'instrument': 'NSE:TWO', 'price': 620},
    ]) + '[/TECHNICAL_PRICE_ANCHORS_V1]'
    source = table().replace('LAURUSLABS', 'ONE') + f'\n| NSE | TWO | {raw} | 610 |'
    result, excluded = normalize_technical_rows(prompt, source, [])
    assert excluded == {'NSE:TWO'}
    assert '| NSE | ONE | 640 | 590 |' in result and 'TWO' not in result
    with pytest.raises(MissingTechnicalListings) as exc:
        validate_technical_prices(prompt, result)
    assert exc.value.accepted_count == 1 and exc.value.ids == ('NSE:TWO',)


@pytest.mark.parametrize(('raw', 'expected'), [
    ('above 630 or 640', '635.00'), ('620–640', '630.00'),
    ('Trigger levels: ₹610, ₹620 and ₹645', '625.00'),
    ('between 600.5 and 620', '610.25'),
])
def test_ambiguous_price_list_is_recorded_as_estimate(raw, expected):
    from app.domains.jobs.technical_prices import normalize_technical_rows
    evidence = []
    result, excluded = normalize_technical_rows(PROMPT, table(trigger=raw), evidence)
    assert not excluded and f'| {expected} | 590 |' in result
    assert evidence[0]['status'] == 'estimated_mean' and evidence[0]['original'] == raw
    assert len(evidence[0]['candidates']) >= 2
    validate_technical_prices(PROMPT, result)
