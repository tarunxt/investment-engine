from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

from app.domains.jobs.usage_identity import resolve_job_usage_identity


def job(**changes):
    return SimpleNamespace(**({"id": 12, "user_id": 7, "auto_rebalance_portfolio": "india", "auto_rebalance_label": "India Run #4 (Swing Scan)", "prompt": "India swing-trade study"} | changes))


def db_with(*responses):
    results = []
    for rows in responses:
        value=Mock();value.all.return_value=rows;results.append(value)
    return SimpleNamespace(begin_nested=lambda:nullcontext(),execute=Mock(side_effect=results))


def test_unique_persisted_sample_and_workflow_link():
    link=SimpleNamespace(run_job_id=45,run_id=10,prompt="India swing-trade study",auto_rebalance_portfolio="india",auto_rebalance_label="India Run #4 (Swing Scan)")
    db=db_with([link],[SimpleNamespace(id=6,stage="swing")])
    assert resolve_job_usage_identity(db,job())=={"run_id":"10","workflow_id":"6","market":"india","stage":"swing","sample_id":"run-job:45"}


def test_distinct_same_model_jobs_remain_distinct_without_run_link():
    first=resolve_job_usage_identity(db_with([],[]),job(id=12))
    second=resolve_job_usage_identity(db_with([],[]),job(id=13))
    assert first["sample_id"] != second["sample_id"]
    assert first["run_id"] is None


def test_unauthenticated_job_does_not_query_other_user_links():
    db=Mock()
    result=resolve_job_usage_identity(db,job(user_id=None))
    db.execute.assert_not_called()
    assert result["workflow_id"] is None


def test_conflicting_market_link_stays_unknown():
    link=SimpleNamespace(run_job_id=45,run_id=10,prompt="US swing-trade study",auto_rebalance_portfolio="indmoney_us",auto_rebalance_label="IndMoney US Run #4 (Swing Scan)")
    result=resolve_job_usage_identity(db_with([link],[]),job())
    assert result["run_id"] is None
    assert result["market"] is None
    assert result["sample_id"]=="job:12"


def test_ambiguous_parent_does_not_guess_one_run():
    links=[SimpleNamespace(run_id=1),SimpleNamespace(run_id=2)]
    result=resolve_job_usage_identity(db_with(links,[]),job())
    assert result["run_id"] is None
    assert result["sample_id"]=="job:12"


def test_lookup_error_is_contained_and_does_not_log_private_error(caplog):
    class Nested:
        def __enter__(self): return self
        def __exit__(self,*args): return False
    db=SimpleNamespace(begin_nested=Nested,execute=Mock(side_effect=RuntimeError("private connection value")))
    result=resolve_job_usage_identity(db,job())
    assert result["run_id"] is None
    assert "RuntimeError" in caplog.text
    assert "private connection value" not in caplog.text


def test_conflicting_stage_is_not_relabelled_by_workflow():
    link=SimpleNamespace(run_job_id=45,run_id=10,prompt="[REBALANCE_FLOW:india]",auto_rebalance_portfolio="india",auto_rebalance_label="India Run #4 (Rebalance Scan)")
    result=resolve_job_usage_identity(db_with([link],[SimpleNamespace(id=6,stage="rebalance")]),job())
    assert result["run_id"]=="10"
    assert result["workflow_id"]=="6"
    assert result["stage"] is None
