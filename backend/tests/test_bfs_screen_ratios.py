import json
from unittest.mock import AsyncMock

import pytest
from app.domains.bottom_fishing import screen_ratios as ratios


def page(metric):
    return f"""<table><tr><th>Company</th><th data-tooltip="{metric}"></th>
    <th data-tooltip="{ratios.SALES}"></th><th data-tooltip="{ratios.PROFIT}"></th></tr>
    <tr data-row-company-id="99"><td>Peer</td><td>999</td><td>20</td><td>2</td></tr>
    <tr data-row-company-id="13"><td>Target</td><td>-1.25</td><td>20.32</td><td>2.1</td></tr></table>""".encode()


@pytest.mark.asyncio
async def test_named_ratios_use_exact_company_period_and_basis(monkeypatch):
    cache = AsyncMock()
    cache.get.return_value = None
    fields = {"screen_source": {"id":"13", "industry":"/market/IN12/IN1201/"},
              "quarter":"Sep 2026", "display":{ratios.SALES:20, ratios.PROFIT:2}}
    schedule = json.dumps({"Profit after tax":{"Jun 2025":788,"Sep 2025":"0"}}).encode()
    fetch = AsyncMock(side_effect=[page(ratios.PE), schedule, b"{}",page(ratios.PAT),b"{}",page(ratios.PAT)])
    monkeypatch.setattr(ratios, "download", fetch)
    assert (await ratios.lookup(None,cache,fields,ratios.PE,"session"))[0] == {ratios.PE:-1.25}
    assert (await ratios.lookup(None,cache,fields,ratios.PAT,"session"))[0] == {ratios.PAT:0}
    assert (await ratios.lookup(None,cache,fields,ratios.PAT,"session"))[0] == {ratios.PAT:-1.25}
    fields["display"][ratios.SALES] = 80
    assert (await ratios.lookup(None,cache,fields,ratios.PAT,"session"))[0] == {}


@pytest.mark.asyncio
async def test_confirm_standalone_statement_before_using_native_prior_year_pat(monkeypatch):
    cache = AsyncMock()
    cache.get.return_value = None
    fields = {"screen_source":{"id":"13","industry":"/market/IN12/IN1201/"},
              "quarter":"Jun 2024", "display":{ratios.SALES:80,ratios.PROFIT:4}}
    target = page(ratios.PAT).replace(b"<td>Target</td>", b'<td><a href="/company/EXAMPLE/">Target</a></td>')
    statement = b"""<div id="company-info" data-company-id="13"></div><section id="quarters">
    <table><thead><tr><th></th><th>Sep 2026</th></tr></thead><tbody>
    <tr><td>Sales</td><td>20</td></tr><tr><td>Net Profit</td><td>2</td></tr></tbody></table></section>"""
    monkeypatch.setattr(ratios, "download", AsyncMock(side_effect=[b"{}",target,statement]))
    assert await ratios.lookup(None,cache,fields,ratios.PAT,"session") == (
        {ratios.PAT:-1.25}, {"basis":"standalone", "period":"Sep 2025"})
