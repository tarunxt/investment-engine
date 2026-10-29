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
