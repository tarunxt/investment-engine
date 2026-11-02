"""A10-006/A10-007: invented offline records, prices and timestamps only."""
from copy import deepcopy
from decimal import Decimal
from itertools import permutations
import json
from pathlib import Path
import subprocess
import sys
import pytest
from app.domains.recommendation_audit.evaluation import walk_forward
from app.domains.recommendation_audit.schemas import Formula, SCORE_FIELDS


def record():
    return {"id":"synthetic-only", "market":"us", "security_id":"synthetic-equity",
            "decision_at":"2024-02-01T12:00:00Z", "original_completion_at":"2024-02-01T12:00:00+00:00",
            "inputs_available_at":"2024-02-01T17:30:00+05:30",
            "coverage":{"successful":1,"attempted":1,"captured_terminal":1},
            "formula":Formula(detailedRationaleDenominator=20).model_dump(mode="json"),
            "samples":[{"provider":"synthetic", "model":"synthetic", "valid":True,
                        "row":dict.fromkeys(SCORE_FIELDS,2)|{"action":"Buy New", "current_units":0, "units_change":1, "final_units":1}}]}


def point(at, price):
    return {"market":"us", "security_id":"synthetic-equity", "at":at,"available_at":at,
            "price":price, "adjusted":True, "tradable":True, "source_hash":"a"*64}


def prices():
    return [point("2024-02-01T12:00:00Z",100), point("2024-02-02T12:00:00Z",101),point("2024-02-03T12:00:00Z",103)]


@pytest.mark.parametrize("alias", ["2024-02-02T12:00:00+00:00","2024-02-02T17:30:00+05:30","2024-02-02T07:00:00-05:00"])
@pytest.mark.parametrize("conflicting", [False,True])
def test_a10_006_equivalent_duplicate_instants_rejected_in_every_order(alias,conflicting):
    points=prices()+[point(alias,90 if conflicting else 101)]
    before=deepcopy(points)
    for ordered in permutations(points):
        with pytest.raises(ValueError,match="Duplicate price time"):
            walk_forward([record()],list(ordered),train_fraction=0,horizons=(1,))
    assert points==before


def test_a10_006_offset_sorting_preserves_raw_timestamps_fees_and_causal_fill():
    points=prices()
    points[0].update(at="2024-02-01T17:30:00+05:30",available_at="2024-02-01T12:00:00+00:00")
    points[1].update(at="2024-02-02T07:00:00-05:00",available_at="2024-02-02T12:00:00+00:00")
    expected=walk_forward([record()],prices(),train_fraction=0,horizons=(1,5))
    before=deepcopy(points)
    for ordered in permutations(points):
        result=walk_forward([record()],list(ordered),train_fraction=0,horizons=(1,5))
        assert result['trades'][0]['fill_at']==points[1]['at']
        assert Decimal(result['trades'][0]['fee'])>0
        assert result['horizons']==expected['horizons']
        for key in ('final_equity','net_return','turnover','max_drawdown_at_price_points'):
            assert result[key]==expected[key]
    assert points==before


def test_a10_006_equivalent_decision_instants_cannot_consume_one_fill_twice():
    first, second = record(), record()
    second.update(id='synthetic-second', decision_at='2024-02-01T07:00:00-05:00')
    for decisions in permutations([first, second]):
        result = walk_forward(list(decisions),prices(),train_fraction=0,horizons=(1,))
        assert len(result['trades']) == 1
        assert len(result['horizons']) == 1
        assert result['skipped'][0]['reason'] == 'Overlapping decision at same fill point'


def test_a10_006_naive_timestamp_is_not_assumed_to_be_original_utc():
    points = prices(); points[1]['at'] = '2024-02-02T12:00:00'
    with pytest.raises(ValueError,match='timezone'):
        walk_forward([record()],points,train_fraction=0)

