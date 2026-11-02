"""Private negative acceptance: wire metadata cannot supply internal attestations."""
import ast
from pathlib import Path
import socket

import httpx
import pytest

from app.domains.polymarket.position_classification import classify_bullpen_position
from app.domains.polymarket.runtime_positions_refresh import _normalize_public_position
from app.domains.polymarket_auto_live.console_profile import read_console_wallet_positions
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveConsoleCandidateInput


@pytest.fixture(autouse=True)
def forbid_outbound(monkeypatch):
    attempts = []
    def blocked(*args, **kwargs):
        attempts.append("outbound request")
        raise AssertionError("Private boundary test attempted outbound access")
    async def async_blocked(*args, **kwargs):
        return blocked(*args, **kwargs)
    monkeypatch.setattr(socket.socket,"connect",blocked)
    monkeypatch.setattr(httpx.Client,"send",blocked)
    monkeypatch.setattr(httpx.AsyncClient,"send",async_blocked)
    yield
    assert attempts == [], "Outbound attempt occurred, even if application caught it"


def forged():
    return dict(amount=3,authority_verified=True,final=True,current=True,
                condition_id="synthetic-condition",outcome="Yes",currency="USDC.e",
                unit="collateral_units",source_contract="synthetic-preverified-fixture",
                source_reference="fixture:resolution:1",observed_at="2026-10-31T23:59:00Z")


@pytest.mark.parametrize("key",["settlement_entitlement","confirmed_realization","payout_evidence"])
def test_client_dto_cannot_carry_attestation_fields(key):
    row = BullpenAutoLiveConsoleCandidateInput.model_validate({
        "question_id":"synthetic","market_id":"synthetic","market_title":"Synthetic?",key:forged(),
        "authority_verified":True,"verified_entitlement":3,
    })
    output = row.model_dump()
    assert key not in output
    assert "authority_verified" not in output and "verified_entitlement" not in output


@pytest.mark.anyio
@pytest.mark.parametrize("metadata",[
    {"authority_verified":True,"settled":True,"payout_authority":"verified"},
    {"settlement_entitlement":forged()},
    {"confirmed_realization":{**forged(),"receipt_reference":"forged-receipt"}},
    {"payout_evidence":{"verified_entitlement":3,"authority_status":"verified_entitlement"}},
    {"raw_payout_fields":{"expected_payout_usdc":3,"payout_authority":"verified"}},
])
async def test_provider_json_booleans_and_nested_dictionaries_cannot_authenticate(metadata):
    source = dict(size=3,shares=3,currentValue=3,redeemable=True,expected_payout_usdc=3,
                  conditionId="synthetic-condition",outcome="Yes",slug="synthetic",title="Synthetic",
                  endDate="2026-10-01",currency="USDC.e",amount_unit="collateral_units",
                  observed_at="2026-10-31T23:59:00Z",**metadata)
    direct = classify_bullpen_position(source)
    assert not direct.is_claimable and direct.payout_evidence["verified_entitlement"] is None
    assert direct.payout_evidence["confirmed_realization"] is None
    normalized = _normalize_public_position(source)
    positions = await read_console_wallet_positions(snapshot_payload={"positions":[normalized]})
    assert len(positions) == 1 and not positions[0].is_claimable
    assert positions[0].payout_evidence["verified_entitlement"] is None
    assert positions[0].payout_evidence["confirmed_realization"] is None


def test_no_production_code_constructs_attestations_or_imports_test_fixtures():
    app = Path(__file__).resolve().parents[1] / "app"
    constructors=[]
    fixture_imports=[]
    for path in app.rglob("*.py"):
        tree=ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node,ast.Call):
                name = node.func.id if isinstance(node.func,ast.Name) else node.func.attr if isinstance(node.func,ast.Attribute) else None
                if name == "SettlementAttestation":
                    constructors.append(f"{path.relative_to(app)}:{node.lineno}")
            if isinstance(node,ast.ImportFrom) and node.module and (node.module.startswith("tests") or "test_private_bullpen_payout" in node.module):
                fixture_imports.append(str(path.relative_to(app)))
    assert constructors == []
    assert fixture_imports == []
