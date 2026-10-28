import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

SPEC = importlib.util.spec_from_file_location("launch_inventory", Path(__file__).with_name("inventory.py"))
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


@pytest.fixture(scope="module")
def scanned():
    return inventory.scan()


def test_inventory_covers_decorated_routes_and_tasks(scanned):
    expected = []
    for path in (inventory.ROOT / "backend/app").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    call = decorator.func if isinstance(decorator, ast.Call) else decorator
                    if isinstance(call, ast.Attribute) and call.attr in inventory.HTTP | {"task"}:
                        expected.append((str(path.relative_to(inventory.ROOT)), node.lineno))
    actual = {(r["source"].rsplit(":", 1)[0], int(r["source"].rsplit(":", 1)[1]))
              for r in scanned["entries"] if r["kind"] in {"http", "websocket", "worker"}}
    assert set(expected) <= actual
    assert not scanned["unresolved"]
    assert all(r["classification"] in {"public", "owner-private", "shared-read", "administrator-only"}
               for r in scanned["entries"])


def test_nested_router_prefix_and_nextauth_methods(scanned):
    routes = scanned["entries"]
    clustering = [r for r in routes if "clustering_progress.py" in r["source"] and r["kind"] in {"http", "websocket"}]
    assert clustering
    assert all(r["route"].startswith("/polymarket/auto-live/") for r in clustering)
    auth = [r for r in routes if r["route"] == "/api/auth/[...nextauth]"]
    assert {r["method"] for r in auth} == {"GET", "POST"}
    assert any(r["route"] == "/ws/jobs/{job_id}" for r in routes)
    assert any(r["kind"] == "scheduler" for r in routes)


def test_user_fixtures_have_separate_profiles(synthetic_users):
    users = list(synthetic_users.values())
    assert len({u.id for u in users}) == 3
    assert len({u.profile.user_id for u in users}) == 3
    assert [u.role.value for u in users] == ["user", "user", "admin"]
    assert all(u.email.endswith("@example.invalid") and u.profile.google_sheets_master_url is None for u in users)


@pytest.mark.asyncio
async def test_google_repeat_preserves_ids_roles_profiles_and_distinct_aliases(isolated_db, synthetic_users):
    from app.domains.auth import google_signin
    from app.domains.auth.models import User
    db = SimpleNamespace(execute=AsyncMock(side_effect=isolated_db.execute),
                         flush=AsyncMock(side_effect=isolated_db.flush),
                         rollback=AsyncMock(side_effect=isolated_db.rollback), add=isolated_db.add,
                         run_sync=AsyncMock(side_effect=lambda fn:fn(isolated_db)))
    for user in synthetic_users.values():
        before = (user.id, user.role, user.profile.user_id, user.profile.bio)
        again = await google_signin.resolve_google_user(db, user.email)
        assert (again.id, again.role, again.profile.user_id, again.profile.bio) == before
    identities = ["synthetic.one@gmail.com", "syntheticone@gmail.com", "synthetic.one+test@gmail.com"]
    created = []
    for email in identities:
        created.append(await google_signin.resolve_google_user(db, email))
        isolated_db.commit()
    assert len({u.id for u in created}) == 3
    assert all(u.role.value == "user" and u.profile.google_sheets_master_url is None for u in created)
    assert len(isolated_db.scalars(select(User)).all()) == 6


def test_fake_broker_cannot_submit_and_accounts_do_not_cross(fake_broker):
    a = fake_broker.preview("userA", "SYNTHETIC", 1)
    b = fake_broker.preview("userB", "SYNTHETIC", 1)
    assert a["account"] != b["account"]
    assert a["simulation"] and b["simulation"]
    with pytest.raises(RuntimeError, match="previews only"):
        fake_broker.submit(a)
    assert fake_broker.orders == []


def test_generated_next_outputs_never_become_source_entrypoints(tmp_path):
    from shutil import copyfile
    (tmp_path/'backend/app/domains/modules').mkdir(parents=True)
    (tmp_path/'backend/app/main.py').write_text('from fastapi import FastAPI\napp=FastAPI()\n')
    copyfile(inventory.ROOT/'backend/app/domains/modules/coverage.py',tmp_path/'backend/app/domains/modules/coverage.py')
    for directory in ('app/actual','.next/types/app/generated','.next-candidate/types/app/generated','.next-uat2-security/types/app/generated'):
        target=tmp_path/'frontend'/directory/'route.ts';target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text('export const GET = () => new Response("fixture");\n')
    result=inventory.scan(tmp_path)
    frontend=[entry for entry in result['entries'] if entry['module']=='frontend']
    assert len(frontend)==1 and frontend[0]['route']=='/actual'
    assert all('/.next' not in path for path in result['source_sha256'])
