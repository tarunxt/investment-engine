"""Installed offline candidate capability metadata; not live-provider qualification."""
from types import SimpleNamespace
import pytest
from test_hosted_analysis_worker import worker_env,linked_env
from app.domains.runs.analysis_router import analysis_config

@pytest.mark.asyncio
async def test_installed_fake_options_modes_are_advertised_without_live_discovery(worker_env):
    _,worker,*_=worker_env
    value=await analysis_config(user=SimpleNamespace(id=1),runtime=worker.analysis.runtime)
    assert value['enabled'] is True
    for mode in ('llm_discovery','shortlist_only','combined'):
        assert value['candidate_modes'][mode]['available'] is True
        assert value['candidate_modes'][mode]['simulation_only'] is True
    assert value['live_discovery_available'] is False
    assert value['orders_authorized'] is False

@pytest.mark.asyncio
@pytest.mark.parametrize('runtime',[None,SimpleNamespace(source=lambda *args:None)])
async def test_unknown_or_absent_runtime_cannot_advertise_candidate_discovery(runtime):
    value=await analysis_config(user=SimpleNamespace(id=1),runtime=runtime)
    assert all(not item['available'] for item in value['candidate_modes'].values())
    assert value['orders_authorized'] is False
