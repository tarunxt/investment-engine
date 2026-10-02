import asyncio
import json
from threading import Event, get_ident
from types import SimpleNamespace

import pytest

from asyncpg.exceptions import CannotConnectNowError, TooManyConnectionsError
from sqlalchemy.exc import DBAPIError, IntegrityError, TimeoutError
from starlette.requests import Request

from app.domains.bullpen_trade_analysis import service
from app.infrastructure.database.errors import database_is_unavailable
from app.infrastructure.database.session import ASYNC_POOL_TIMEOUT_SECONDS


def test_database_shutdown_pool_and_connection_failures_are_transient():
    shutdown = CannotConnectNowError('the database system is shutting down')
    assert database_is_unavailable(shutdown)
    assert database_is_unavailable(DBAPIError('select', {}, shutdown))
    assert database_is_unavailable(ExceptionGroup('request', [shutdown]))
    assert database_is_unavailable(TooManyConnectionsError('too many clients'))
    assert database_is_unavailable(TimeoutError('pool wait'))


def test_application_bugs_and_invalid_writes_are_not_reported_as_outages():
    assert not database_is_unavailable(ValueError('invalid rank'))
    assert not database_is_unavailable(IntegrityError('insert', {}, ValueError('constraint')))


def test_database_pool_exhaustion_fails_inside_the_proxy_deadline():
    assert ASYNC_POOL_TIMEOUT_SECONDS == 5


def test_outage_response_is_retryable_without_exposing_driver_detail():
    from app.main import general_exception_handler
    request = Request({'type': 'http', 'method': 'GET', 'path': '/api/sports-rankings'})
    response = asyncio.run(general_exception_handler(request, CannotConnectNowError('internal details')))
    assert response.status_code == 503
    assert response.headers['retry-after'] == '3'
    assert json.loads(response.body)['error'] == 'DATABASE_UNAVAILABLE'
    assert b'internal details' not in response.body


def test_redeemed_history_lookup_keeps_event_loop_responsive(monkeypatch):
    lookup_started = Event()
    release_lookup = Event()
    lifecycle: list[tuple[str, int]] = []
    lookups: list[dict[str, object]] = []
    event_loop_thread = get_ident()

    class Session:
        def __enter__(self):
            lifecycle.append(("enter", get_ident()))
            return self

        def __exit__(self, *_args):
            lifecycle.append(("exit", get_ident()))

        def commit(self):
            lifecycle.append(("commit", get_ident()))

    def find_open_trade(_session, **kwargs):
        lifecycle.append(("lookup", get_ident()))
        lookups.append(kwargs)
        lookup_started.set()
        # A finite wait keeps this regression test from hanging on the old
        # implementation, which runs this lookup on the event-loop thread.
        release_lookup.wait(timeout=1)
        return None

    monkeypatch.setattr(service, "SyncSessionLocal", Session)
    monkeypatch.setattr(service, "_find_open_trade", find_open_trade)
    redeemed = SimpleNamespace(
        market_id="fixture-market",
        market_title="Fixture title",
        outcome="Yes",
    )

    async def scenario():
        task = asyncio.create_task(
            service.sync_redeemed_trades_async(
                user_id=17,
                redeemed_trades=iter([redeemed]),
            )
        )
        try:
            assert await asyncio.wait_for(
                asyncio.to_thread(lookup_started.wait, 2),
                timeout=3,
            )
            # An unrelated coroutine can run while the DB lookup is blocked.
            await asyncio.sleep(0)
            assert not task.done()
            assert [operation for operation, _thread in lifecycle] == [
                "enter",
                "lookup",
            ]
        finally:
            release_lookup.set()
            await task

    asyncio.run(scenario())

    assert lookups == [
        {
            "user_id": 17,
            "market_id": "fixture-market",
            "outcome_name": "Yes",
            "title": "Fixture title",
        }
    ]
    assert [operation for operation, _thread in lifecycle] == [
        "enter",
        "lookup",
        "commit",
        "exit",
    ]
    session_threads = {thread for _operation, thread in lifecycle}
    assert len(session_threads) == 1
    assert event_loop_thread not in session_threads


def test_redeemed_history_failure_propagates_and_closes_session(monkeypatch):
    failure = RuntimeError("synthetic lookup failure")
    lifecycle: list[object] = []

    class Session:
        def __enter__(self):
            lifecycle.append("enter")
            return self

        def __exit__(self, _exc_type, exc, _traceback):
            lifecycle.append(exc)

        def commit(self):
            lifecycle.append("commit")

    def find_open_trade(_session, **_kwargs):
        raise failure

    monkeypatch.setattr(service, "SyncSessionLocal", Session)
    monkeypatch.setattr(service, "_find_open_trade", find_open_trade)

    with pytest.raises(RuntimeError) as captured:
        asyncio.run(
            service.sync_redeemed_trades_async(
                user_id=17,
                redeemed_trades=[SimpleNamespace()],
            )
        )

    assert captured.value is failure
    assert lifecycle == ["enter", failure]


def test_redeemed_history_cancellation_waits_for_transaction_cleanup(monkeypatch):
    commit_started = Event()
    release_commit = Event()
    lifecycle: list[str] = []

    class Session:
        def __enter__(self):
            lifecycle.append("enter")
            return self

        def __exit__(self, *_args):
            lifecycle.append("exit")

        def commit(self):
            lifecycle.append("commit_started")
            commit_started.set()
            release_commit.wait(timeout=1)
            lifecycle.append("commit_finished")

    monkeypatch.setattr(service, "SyncSessionLocal", Session)

    async def scenario():
        task = asyncio.create_task(
            service.sync_redeemed_trades_async(user_id=17, redeemed_trades=[])
        )
        try:
            assert await asyncio.wait_for(
                asyncio.to_thread(commit_started.wait, 2),
                timeout=3,
            )
            for _ in range(2):
                task.cancel()
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                assert not task.done()
                assert lifecycle == ["enter", "commit_started"]
        finally:
            release_commit.set()
            with pytest.raises(asyncio.CancelledError):
                await task

        assert lifecycle == ["enter", "commit_started", "commit_finished", "exit"]

    asyncio.run(scenario())


@pytest.mark.parametrize("second_user_id", [17, 18])
@pytest.mark.parametrize("cancel_first", [False, True])
def test_redeemed_history_serializes_only_same_user(
    monkeypatch, second_user_id, cancel_first
):
    first_started = Event()
    second_started = Event()
    release_first = Event()
    lifecycle: list[str] = []

    def sync_history(*, user_id, redeemed_trades):
        del user_id
        name = next(iter(redeemed_trades))
        lifecycle.append(f"{name}:start")
        if name == "first":
            first_started.set()
            release_first.wait(timeout=2)
        else:
            second_started.set()
        lifecycle.append(f"{name}:end")

    monkeypatch.setattr(service, "_sync_redeemed_trades_sync", sync_history)

    async def scenario():
        loop = asyncio.get_running_loop()
        first = asyncio.create_task(
            service.sync_redeemed_trades_async(user_id=17, redeemed_trades=["first"])
        )
        second = None
        try:
            assert await asyncio.to_thread(first_started.wait, 1)
            if cancel_first:
                first.cancel()
                await asyncio.sleep(0)
            second = asyncio.create_task(
                service.sync_redeemed_trades_async(
                    user_id=second_user_id,
                    redeemed_trades=["second"],
                )
            )
            entered_before_first_completed = await asyncio.to_thread(
                second_started.wait,
                0.05 if second_user_id == 17 else 1,
            )
            assert entered_before_first_completed is (second_user_id != 17)
        finally:
            release_first.set()
            results = await asyncio.gather(
                first, *([second] if second else []), return_exceptions=True
            )
        if cancel_first:
            assert isinstance(results[0], asyncio.CancelledError)
        else:
            assert results[0] is None
        assert results[1] is None
        assert (loop, 17) not in service._redeemed_history_sync_locks
        assert (loop, second_user_id) not in service._redeemed_history_sync_locks

    # A fresh loop must not inherit a previously bound asyncio lock.
    for _ in range(2):
        first_started.clear()
        second_started.clear()
        release_first.clear()
        lifecycle.clear()
        asyncio.run(scenario())
        if second_user_id == 17:
            assert lifecycle == ["first:start", "first:end", "second:start", "second:end"]
        else:
            assert lifecycle == ["first:start", "second:start", "second:end", "first:end"]


def test_redeemed_history_cancelled_waiter_never_starts_transaction(monkeypatch):
    first_started = Event()
    release_first = Event()
    entered: list[str] = []

    def sync_history(*, user_id, redeemed_trades):
        del user_id
        name = next(iter(redeemed_trades))
        entered.append(name)
        if name == "first":
            first_started.set()
            release_first.wait(timeout=2)

    monkeypatch.setattr(service, "_sync_redeemed_trades_sync", sync_history)

    async def scenario():
        first = asyncio.create_task(
            service.sync_redeemed_trades_async(user_id=17, redeemed_trades=["first"])
        )
        waiter = None
        try:
            assert await asyncio.to_thread(first_started.wait, 1)
            waiter = asyncio.create_task(
                service.sync_redeemed_trades_async(user_id=17, redeemed_trades=["waiter"])
            )
            await asyncio.sleep(0)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            assert entered == ["first"]
            assert not first.done()
        finally:
            release_first.set()
            await first
            if waiter is not None:
                await asyncio.gather(waiter, return_exceptions=True)
        await service.sync_redeemed_trades_async(user_id=17, redeemed_trades=["next"])

    asyncio.run(scenario())
    assert entered == ["first", "next"]
