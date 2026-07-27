from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, *, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_router() -> None:
    path = "backend/app/domains/polymarket_auto_live/router.py"
    text = read(path)
    text = replace_once(
        text,
        '''    return snapshot, user_id, database_duration_ms


def _http_error_detail(exc: Exception) -> str:
''',
        '''    return snapshot, user_id, database_duration_ms


async def _read_dashboard_summary(
    credentials: HTTPAuthorizationCredentials | None,
) -> tuple[BullpenAutoLiveSummary, int]:
    """Read auth and the dashboard projection through one database session.

    The dashboard used to resolve ``get_current_user`` in one session and then
    open another session inside ``get_dashboard_summary``. Under pool pressure
    that second checkout could consume the entire four-second browser budget,
    leaving a completed run displayed as queued. Reusing the authenticated
    session keeps the read bounded and prevents the stage monitor from going
    stale while workers continue successfully in the background.
    """

    async with AsyncSessionLocal() as session:
        user_id = await _resolve_persisted_status_user_id(credentials, session)
        bot = await polymarket_auto_live_bot_manager.get_bot(user_id)
        summary = await bot.get_dashboard_summary(session=session)
        summary = BullpenAutoLiveSummary.model_validate(summary)
    return summary, user_id


def _http_error_detail(exc: Exception) -> str:
''',
        label="insert single-session dashboard reader",
    )
    text = replace_once(
        text,
        '''@router.get("/summary/dashboard", response_model=BullpenAutoLiveSummary)
async def get_auto_live_dashboard_summary(
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
):
    """Load persisted console projections without worker or runtime work."""

    started_at = time.perf_counter()
    bot = await _get_bot(current_user)
    try:
        summary = await asyncio.wait_for(
            bot.get_dashboard_summary(),
            timeout=DASHBOARD_SUMMARY_TIMEOUT_SECONDS,
        )
        summary = await _attach_latest_active_auth(
            summary,
            refresh_if_stale=False,
            timeout_seconds=DASHBOARD_AUTH_CACHE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Auto-Live dashboard data is temporarily delayed. Retry shortly.",
            headers={"Cache-Control": "no-store"},
        ) from exc
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc
''',
        '''@router.get("/summary/dashboard", response_model=BullpenAutoLiveSummary)
async def get_auto_live_dashboard_summary(
    request: Request,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    """Load persisted console projections without worker or runtime work."""

    started_at = time.perf_counter()
    user_id: int | None = None
    try:
        summary, user_id = await asyncio.wait_for(
            _read_dashboard_summary(credentials),
            timeout=DASHBOARD_SUMMARY_TIMEOUT_SECONDS,
        )
        summary = await _attach_latest_active_auth(
            summary,
            refresh_if_stale=False,
            timeout_seconds=DASHBOARD_AUTH_CACHE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Auto-Live dashboard data is temporarily delayed. Retry shortly.",
            headers={"Cache-Control": "no-store"},
        ) from exc
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc
''',
        label="reuse dashboard auth session in route",
    )
    text = replace_once(
        text,
        '                    "user_id": current_user.id,\n',
        '                    "user_id": user_id,\n',
        label="dashboard slow-log user id",
    )
    write(path, text)


def patch_bot() -> None:
    path = "backend/app/domains/polymarket_auto_live/bot.py"
    text = read(path)
    text = replace_once(
        text,
        '''    async def get_dashboard_summary(self) -> BullpenAutoLiveSummary:
''',
        '''    async def get_dashboard_summary(
        self,
        session: AsyncSession | None = None,
    ) -> BullpenAutoLiveSummary:
''',
        label="dashboard summary optional session signature",
    )

    function_start = text.index("    async def get_dashboard_summary(")
    block_start = text.index(
        "        query_started_at = perf_counter()\n"
        "        async with AsyncSessionLocal() as session:\n",
        function_start,
    )
    block_end = text.index("\n\n        database_duration_ms", block_start)
    block = text[block_start:block_end]
    lines = block.splitlines()
    if lines[:2] != [
        "        query_started_at = perf_counter()",
        "        async with AsyncSessionLocal() as session:",
    ]:
        raise RuntimeError("dashboard summary session block changed unexpectedly")
    dedented = "\n".join(
        line[4:] if line.startswith("    ") else line for line in lines[2:]
    )
    replacement = (
        "        if session is None:\n"
        "            async with AsyncSessionLocal() as owned_session:\n"
        "                return await self.get_dashboard_summary(session=owned_session)\n"
        "\n"
        "        query_started_at = perf_counter()\n"
        f"{dedented}"
    )
    text = text[:block_start] + replacement + text[block_end:]
    write(path, text)


def patch_frontend() -> None:
    path = "frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx"
    text = read(path)
    text = replace_once(
        text,
        '''      const nextSummary = await apiService.getBullpenAutoLiveDashboardSummary({
        signal: requestSignal,
        timeoutMs: 4_000,
      });
''',
        '''      const nextSummary = await apiService.getBullpenAutoLiveDashboardSummary({
        signal: requestSignal,
        timeoutMs: 5_000,
      });
''',
        label="dashboard browser timeout headroom",
    )
    text = replace_once(
        text,
        '''    } catch (nextError) {
      if (requestSignal?.aborted || isRequestAbort(nextError)) {
        return null;
      }
      setError(normalizeError(nextError));
      return null;
    } finally {
''',
        '''    } catch (nextError) {
      if (requestSignal?.aborted || isRequestAbort(nextError)) {
        return null;
      }
      const isTransientDashboardRead =
        nextError instanceof RequestTimeoutError ||
        (nextError instanceof APIError && nextError.status >= 500);
      if (isTransientDashboardRead && visiblePersistedAutoRunStatus) {
        console.warn(
          JSON.stringify({
            event: "bullpen_auto_run_dashboard_poll_degraded",
            reason:
              nextError instanceof RequestTimeoutError
                ? "timeout"
                : nextError instanceof APIError
                  ? `http_${nextError.status}`
                  : "unavailable",
          }),
        );
        window.setTimeout(() => {
          if (!requestSignal?.aborted) {
            void loadSummary({
              preserveLoading: true,
              nextPendingRunId: resolvedPendingRunId,
            });
          }
        }, POLL_INTERVAL_MS);
        return summary;
      }
      setError(normalizeError(nextError));
      return null;
    } finally {
''',
        label="transient dashboard poll recovery",
    )
    write(path, text)


def patch_backend_tests() -> None:
    path = "backend/tests/test_polymarket_auto_live_router.py"
    text = read(path)
    text = replace_once(
        text,
        '''from app.domains.polymarket_auto_live.router import _fit_dashboard_response_budget
''',
        '''from app.domains.polymarket_auto_live.router import (
    _fit_dashboard_response_budget,
    _read_dashboard_summary,
)
''',
        label="import dashboard reader test target",
    )
    marker = '''@pytest.mark.anyio
async def test_dashboard_summary_uses_cached_auth_and_supports_etag(monkeypatch):
'''
    inserted = '''@pytest.mark.anyio
async def test_dashboard_summary_reader_reuses_single_database_session(monkeypatch):
    shared_session = object()
    events: list[tuple[str, object]] = []
    summary = BullpenAutoLiveSummary(
        state=BullpenAutoLiveState(),
        settings=BullpenAutoLiveSettings(),
        bot_card=BullpenAutoLiveBotCardSummary(
            status="stopped",
            mode="analysis-only",
            guardrails_summary="Ready",
            strategy_summary="Ready",
            risk_summary="Ready",
        ),
    )

    class FakeSessionContext:
        async def __aenter__(self):
            events.append(("enter", shared_session))
            return shared_session

        async def __aexit__(self, _exc_type, _exc, _traceback):
            events.append(("exit", shared_session))
            return False

    class FakeBot:
        async def get_dashboard_summary(self, session=None):
            events.append(("summary", session))
            return summary

    async def fake_resolve_user(_credentials, session):
        events.append(("auth", session))
        return 7

    async def fake_get_bot(user_id: int):
        events.append(("bot", user_id))
        return FakeBot()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.AsyncSessionLocal",
        FakeSessionContext,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._resolve_persisted_status_user_id",
        fake_resolve_user,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.polymarket_auto_live_bot_manager.get_bot",
        fake_get_bot,
    )

    result, user_id = await _read_dashboard_summary(None)

    assert result == summary
    assert user_id == 7
    assert events == [
        ("enter", shared_session),
        ("auth", shared_session),
        ("bot", 7),
        ("summary", shared_session),
        ("exit", shared_session),
    ]


@pytest.mark.anyio
async def test_dashboard_summary_uses_cached_auth_and_supports_etag(monkeypatch):
'''
    text = replace_once(
        text,
        marker,
        inserted,
        label="single-session dashboard regression test",
    )
    text = replace_once(
        text,
        '''    class FakeBot:
        async def get_dashboard_summary(self):
            return summary

    async def fake_get_bot(_current_user):
        return FakeBot()

    async def fake_attach_auth(
''',
        '''    summary_reads: list[bool] = []

    async def fake_read_dashboard_summary(_credentials):
        summary_reads.append(True)
        return summary, 7

    async def fake_attach_auth(
''',
        label="dashboard route fake reader",
    )
    text = replace_once(
        text,
        '''    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._get_bot",
        fake_get_bot,
    )
''',
        '''    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._read_dashboard_summary",
        fake_read_dashboard_summary,
    )
''',
        label="dashboard route reader monkeypatch",
    )
    text = replace_once(
        text,
        '''    assert cached.status_code == 304
    assert auth_reads == [(False, 0.25), (False, 0.25)]
''',
        '''    assert cached.status_code == 304
    assert summary_reads == [True, True]
    assert auth_reads == [(False, 0.25), (False, 0.25)]
''',
        label="dashboard route reader assertion",
    )
    write(path, text)


def patch_frontend_tests() -> None:
    path = "frontend/tests/bullpen-ai-compatibility.test.mjs"
    text = read(path)
    text = replace_once(
        text,
        '''  assert.doesNotMatch(autoRunCardSource, /refreshes every 4 seconds/);
  assert.match(autoRunCardSource, /Pause/);
''',
        '''  assert.doesNotMatch(autoRunCardSource, /refreshes every 4 seconds/);
  assert.match(autoRunCardSource, /timeoutMs: 5_000/);
  assert.match(autoRunCardSource, /bullpen_auto_run_dashboard_poll_degraded/);
  assert.match(autoRunCardSource, /nextPendingRunId: resolvedPendingRunId/);
  assert.match(autoRunCardSource, /Pause/);
''',
        label="frontend dashboard poll regression assertions",
    )
    write(path, text)


def main() -> None:
    patch_router()
    patch_bot()
    patch_frontend()
    patch_backend_tests()
    patch_frontend_tests()


if __name__ == "__main__":
    main()
