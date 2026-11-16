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
