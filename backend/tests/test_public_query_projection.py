"""Closed projection evidence: no arbitrary field ever becomes outbound text."""
import json
import pytest


@pytest.fixture(autouse=True)
def require_guard():
    import os
    if os.environ.get('A9_CONSUMER_GUARDED') != '1':
        pytest.skip('run verify-search-consumers-offline.py for pre-import guards')


@pytest.mark.parametrize('market', ['india','us','global'])
@pytest.mark.parametrize('topic', ['prices','news','earnings','macro'])
def test_structured_public_fields_project_only_trusted_constants(monkeypatch, market, topic):
    from app.domains.ai_providers.tools import web_search
    from app.domains.ai_providers.tools.public_queries import PUBLIC_MARKETS, PUBLIC_TOPICS, admitted_query
    calls=[]
    query=f'{PUBLIC_MARKETS[market]} {PUBLIC_TOPICS[topic]}'
    def fake(q,count):
        calls.append((q,count))
        return json.dumps({'results':[{'url':'https://example.invalid/source','content':'warning; disagree'}]})
    monkeypatch.setattr(web_search,'_web_search',fake)
    out=web_search.execute('web_search',{'market':market,'topic':topic,'max_results':2})
    assert calls==[(query,2)]
    assert admitted_query(out)==query
    assert json.loads(out)['trust']=='untrusted_external_data'


@pytest.mark.parametrize('args', [
    {'query':'NIFTY 50 live price today private account 123'},
    {'query':'NIFTY 50 live price today\n'},
    {'market':'india','topic':'prices','query':'private'},
    {'market':'india','topic':'prices','account_id':'123'},
    {'market':'private account 123','topic':'prices'},
    {'market':'india','topic':'private holdings'},
    {'market':['india'],'topic':'prices'}, {},
])
def test_ambiguous_or_private_fields_never_dispatch_or_echo(monkeypatch,args):
    from app.domains.ai_providers.tools import web_search
    from app.domains.ai_providers.tools.public_queries import admitted_query
    from unittest.mock import Mock
    transport=Mock(side_effect=AssertionError('private egress'))
    monkeypatch.setattr(web_search,'_web_search',transport)
    out=web_search.execute('web_search',args)
    transport.assert_not_called()
    assert admitted_query(out) is None
    assert json.loads(out)['results']==[]
    assert 'private account 123' not in out


def test_dispatch_boundary_blocks_private_query_before_config_or_transport(monkeypatch):
    from app.domains.ai_providers.tools import web_search
    from unittest.mock import Mock
    for name in ['_tavily_search','_ddg_search','_bing_rss_search']:
        monkeypatch.setattr(web_search,name,Mock(side_effect=AssertionError('egress')))
    out=web_search._web_search('synthetic private holdings account fixture',5)
    assert json.loads(out)['errors']
    for name in ['_tavily_search','_ddg_search','_bing_rss_search']:
        getattr(web_search,name).assert_not_called()


def test_metadata_cannot_be_forged_with_private_query():
    from app.domains.ai_providers.tools.public_queries import admitted_query
    assert admitted_query(json.dumps({'query':'private account fixture','results':[]})) is None
    assert admitted_query(json.dumps({'query':'NIFTY 50 live price today','errors':['blocked']})) is None


def test_provider_capability_does_not_claim_native_search_is_attached():
    from app.domains.ai_providers.factory import ProviderFactory
    assert ProviderFactory.get_provider_internet_access('gemini')['mode']=='none'
