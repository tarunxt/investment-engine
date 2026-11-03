#!/usr/bin/env python3
"""Isolated lifecycle proof; blocks egress/process creation before code imports.

Executes real JWT/lifecycle source with synthetic signing settings and a
transaction/lock store double. Does not prove PostgreSQL locking or migration.
Use --run PATH [ARGS] to run another synthetic test entrypoint with the same
egress guards installed before its imports.
"""
import socket
import subprocess
import os


def forbidden(*args, **kwargs):
    raise AssertionError("Network/process egress forbidden in lifecycle proof")


for owner, names in ((socket, ("create_connection", "getaddrinfo")),
                     (socket.socket, ("connect", "connect_ex", "sendto")),
                     (subprocess, ("Popen",)),
                     (os, ("system", "fork", "posix_spawn", "posix_spawnp"))):
    for name in names:
        if hasattr(owner, name):
            setattr(owner, name, forbidden)

# Reuse the guard for existing synthetic suites without importing application
# modules or JWT dependencies first (the basket proof uses another interpreter).
import sys
if len(sys.argv) > 2 and sys.argv[1] == "--run":
    import runpy
    sys.argv = sys.argv[2:]
    runpy.run_path(sys.argv[0], run_name="__main__")
    raise SystemExit(0)

# Third-party/application source imports occur only after guards above.
import ast
import asyncio
import copy
from datetime import datetime, timedelta
import hashlib
from pathlib import Path
import secrets
from types import SimpleNamespace
from typing import Any, Dict, Optional
import unittest
from jose import JWTError, jwt

ROOT = Path(__file__).resolve().parents[1]
KEY = "synthetic-offline-session-family-key-only-" * 2


class Denied(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code


def load(relative, namespace, names=None):
    path = ROOT / relative
    tree = ast.parse(path.read_text())
    nodes = [n for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom))]
    if names:
        nodes = [n for n in nodes if getattr(n, "name", None) in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


ns = dict(datetime=datetime, timedelta=timedelta, Optional=Optional, Dict=Dict,
          Any=Any, JWTError=JWTError, jwt=jwt, hashlib=hashlib, secrets=secrets,
          HTTPException=Denied, ALGORITHM="HS256", ACCESS_TOKEN_EXPIRE_MINUTES=15,
          REFRESH_TOKEN_EXPIRE_DAYS=7,
          settings=SimpleNamespace(jwt_signing_key=SimpleNamespace(get_secret_value=lambda: KEY)))
load("app/core/security.py", ns, {"JWTUtils", "AuthUtils"})
load("app/domains/auth/session_lifecycle.py", ns)
Lifecycle, JWT = ns["SessionLifecycle"], ns["JWTUtils"]


class Database:
    def __init__(self):
        self.users = {uid: SimpleNamespace(id=uid, email=f"fixture{uid}@example.invalid",
                       is_active=True, role=SimpleNamespace(value="user")) for uid in (42, 99)}
        self.families = {}
        self.locks = {uid: asyncio.Lock() for uid in self.users}
        self.fail = False
        self.fail_commit = False


class Store:
    def __init__(self, db):
        self.db = db
        self.pending = {}
        self.locked = None

    def check(self):
        if self.db.fail:
            raise RuntimeError("synthetic durable storage failure")

    async def lock_user(self, uid):
        self.check()
        if uid not in self.db.users:
            return None
        if self.locked is None:
            await self.db.locks[uid].acquire()
            self.locked = uid
        assert self.locked == uid
        return self.db.users[uid]

    async def lock_family(self, uid, sid):
        self.check()
        assert self.locked == uid
        row = self.db.families.get(sid)
        if row is None or row.user_id != uid:
            return None
        self.pending[sid] = copy.copy(row)
        return self.pending[sid]

    async def lock_intent(self, token_digest):
        self.check()
        return None  # Baseline model suite has no dispatch-intent fixtures.

    async def active(self, uid, sid):
        self.check()
        row = self.db.families.get(sid)
        if self.db.users.get(uid) is None or not self.db.users[uid].is_active:
            return None
        return row if row and row.user_id == uid else None

    async def create(self, uid, sid, token_digest, expiry):
        self.check()
        assert self.locked == uid
        assert sid not in self.db.families
        self.pending[sid] = SimpleNamespace(id=sid, user_id=uid, refresh_digest=token_digest,
                                           expires_at=expiry, is_active=True)

    async def revoke_all(self, uid):
        self.check()
        assert self.locked == uid
        for sid, row in self.db.families.items():
            if row.user_id == uid:
                self.pending[sid] = copy.copy(row)
                self.pending[sid].is_active = False

    async def commit(self):
        self.check()
        if self.db.fail_commit:
            raise RuntimeError("synthetic commit failure")
        self.db.families.update(self.pending)
        self.release()

    def release(self):
        self.pending = {}
        if self.locked is not None:
            self.db.locks[self.locked].release()
            self.locked = None


class Proof(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = Database()

    async def issue(self, uid=42):
        store = Store(self.db)
        try:
            tokens = await Lifecycle(store).issue(self.db.users[uid])
            await store.commit()
            return tokens
        finally:
            store.release()

    async def rotate(self, token):
        store = Store(self.db)
        try:
            _, tokens = await Lifecycle(store).rotate(token)
            await store.commit()
            return tokens
        finally:
            store.release()

    async def active(self, token):
        payload = JWT.verify_access_token(token)
        if payload is None:
            raise ns["denied"]()
        return await Lifecycle(Store(self.db)).require_active(payload)

    async def test_new_family_and_valid_rotation_preserve_purpose_and_lifetimes(self):
        pair = await self.issue()
        rotated = await self.rotate(pair["refresh_token"])
        a = JWT.verify_access_token(rotated["access_token"])
        r = JWT.verify_refresh_token(rotated["refresh_token"])
        self.assertNotIn("type", a)
        self.assertEqual(a["sid"], r["sid"])
        self.assertEqual(a["exp"] - a["iat"], 900)
        self.assertEqual(r["exp"] - r["iat"], 604800)
        self.assertNotEqual(pair["refresh_token"], rotated["refresh_token"])
        await self.active(rotated["access_token"])
        self.assertEqual(self.db.families[a["sid"]].refresh_digest, ns["digest"](rotated["refresh_token"]))
        self.assertNotIn(rotated["refresh_token"], repr(self.db.families))

    async def test_logout_revokes_current_only_including_rotated_access(self):
        first, other = await self.issue(), await self.issue()
        rotated = await self.rotate(first["refresh_token"])
        store = Store(self.db)
        await Lifecycle(store).revoke_current(JWT.verify_access_token(first["access_token"]))
        await store.commit()
        for token in (first["access_token"], rotated["access_token"]):
            with self.assertRaises(Denied):
                await self.active(token)
        with self.assertRaises(Denied):
            await self.rotate(rotated["refresh_token"])
        await self.active(other["access_token"])

    async def test_password_event_revokes_all_user_families_only(self):
        first, second, other_account = await self.issue(), await self.issue(), await self.issue(99)
        store = Store(self.db)
        await Lifecycle(store).revoke_all(42)
        # No effect outside the transaction before commit.
        await self.active(first["access_token"])
        await store.commit()
        for pair in (first, second):
            with self.assertRaises(Denied):
                await self.active(pair["access_token"])
            with self.assertRaises(Denied):
                await self.rotate(pair["refresh_token"])
        await self.active(other_account["access_token"])

    async def test_reuse_commits_family_revocation_before_denial(self):
        pair, other = await self.issue(), await self.issue()
        rotated = await self.rotate(pair["refresh_token"])
        with self.assertRaises(Denied):
            await self.rotate(pair["refresh_token"])
        with self.assertRaises(Denied):
            await self.active(rotated["access_token"])
        with self.assertRaises(Denied):
            await self.rotate(rotated["refresh_token"])
        await self.active(other["access_token"])

    async def test_concurrent_duplicate_refresh_one_rotation_then_family_revocation(self):
        pair = await self.issue()
        results = await asyncio.gather(self.rotate(pair["refresh_token"]), self.rotate(pair["refresh_token"]), return_exceptions=True)
        self.assertEqual(sum(isinstance(r, dict) for r in results), 1)
        self.assertEqual(sum(isinstance(r, Denied) for r in results), 1)
        winner = next(r for r in results if isinstance(r, dict))
        with self.assertRaises(Denied):
            await self.active(winner["access_token"])

    async def test_unavailable_store_and_missing_family_never_authorize_or_issue(self):
        pair = await self.issue()
        self.db.fail = True
        for action in (lambda: self.active(pair["access_token"]), lambda: self.rotate(pair["refresh_token"]), self.issue):
            with self.assertRaises(RuntimeError):
                await action()
        self.db.fail = False
        self.db.families.clear()
        with self.assertRaises(Denied):
            await self.active(pair["access_token"])
        with self.assertRaises(Denied):
            await self.rotate(pair["refresh_token"])

    async def test_commit_failure_returns_no_replacement_and_does_not_restore_family(self):
        pair = await self.issue()
        self.db.fail_commit = True
        with self.assertRaises(RuntimeError):
            await self.rotate(pair["refresh_token"])
        self.db.fail_commit = False
        # Transaction rollback in the double retains the last committed token.
        await self.rotate(pair["refresh_token"])

    async def test_inactive_expired_unknown_and_legacy_sessions_deny(self):
        pair = await self.issue()
        self.db.users[42].is_active = False
        with self.assertRaises(Denied):
            await self.active(pair["access_token"])
        self.db.users[42].is_active = True
        sid = JWT.verify_access_token(pair["access_token"])["sid"]
        self.db.families[sid].expires_at = datetime.utcnow() - timedelta(seconds=1)
        with self.assertRaises(Denied):
            await self.active(pair["access_token"])
        for token in (JWT.create_access_token(42, "fixture@example.invalid", "user"),
                      JWT.create_access_token(42, "fixture@example.invalid", "user", session_id="x" * 43)):
            with self.assertRaises(Denied):
                await self.active(token)

    async def test_wrong_purpose_and_malformed_subject_cannot_revoke_family(self):
        pair = await self.issue()
        with self.assertRaises(Denied):
            await self.rotate(pair["access_token"])
        for sub in (None, "x", [], {}, "0", "-1"):
            claims = JWT.verify_refresh_token(pair["refresh_token"])
            claims["sub"] = sub
            with self.assertRaises(Denied):
                await self.rotate(jwt.encode(claims, KEY, algorithm="HS256"))
        await self.active(pair["access_token"])

    async def test_password_and_issuance_serialize_on_user_lock(self):
        pair = await self.issue()
        store = Store(self.db)
        await Lifecycle(store).revoke_all(42)
        pending = asyncio.create_task(self.issue())
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        await store.commit()
        new_login = await pending
        with self.assertRaises(Denied):
            await self.active(pair["access_token"])
        await self.active(new_login["access_token"])

    async def test_egress_guards_active(self):
        for action in (lambda: socket.getaddrinfo("example.invalid", 443),
                       lambda: subprocess.Popen(["true"]), lambda: os.system("true")):
            with self.assertRaises(AssertionError):
                action()

    async def test_parallel_different_families_remain_independent(self):
        first, second = await self.issue(), await self.issue()
        rotated = await asyncio.gather(self.rotate(first["refresh_token"]), self.rotate(second["refresh_token"]))
        for pair in rotated:
            await self.active(pair["access_token"])

    async def test_logout_serializes_with_pending_rotation(self):
        pair = await self.issue()
        store = Store(self.db)
        _, rotated = await Lifecycle(store).rotate(pair["refresh_token"])
        async def logout():
            logout_store = Store(self.db)
            try:
                await Lifecycle(logout_store).revoke_current(JWT.verify_access_token(pair["access_token"]))
                await logout_store.commit()
            finally:
                logout_store.release()
        task = asyncio.create_task(logout())
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        await store.commit()
        await task
        with self.assertRaises(Denied):
            await self.active(rotated["access_token"])


class BoundaryProof(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = Proof.asyncSetUp
    issue = Proof.issue
    rotate = Proof.rotate
    active = Proof.active
    def websocket_runtime(self):
        import time
        import math
        import logging
        async def ticket(_):
            return None
        db = self.db
        class Context:
            async def __aenter__(self):
                return db
            async def __aexit__(self, *args):
                return None
        namespace = dict(asyncio=asyncio, time=time, math=math, logging=logging,
                         json=__import__("json"), WebSocket=object,
                         WebSocketDisconnect=Exception, JWTUtils=JWT,
                         SessionLifecycle=Lifecycle, subject=ns["subject"],
                         SqlSessionFamilies=Store, AsyncSessionLocal=Context,
                         is_auth_disabled=lambda: False, consume_websocket_ticket=ticket)
        load("app/shared/ws_relay.py", namespace)
        return namespace

    async def test_websocket_revalidates_family_and_expiry_and_store_failure(self):
        pair = await self.issue()
        ws = self.websocket_runtime()
        identity = await ws["user_id_from_ws_token"](pair["access_token"])
        self.assertEqual(identity, 42)
        self.assertIsNone(await ws["user_id_from_ws_token"](pair["refresh_token"]))
        self.db.fail = True
        self.assertFalse(await ws["session_identity_active"](identity))
        self.db.fail = False
        for expiry in (-1, None, "invalid", float("inf"), float("nan")):
            expired = ws["SessionIdentity"](42, {**identity.claims, "exp": expiry})
            self.assertFalse(await ws["session_identity_active"](expired))
        store = Store(self.db)
        await Lifecycle(store).revoke_current(identity.claims)
        await store.commit()
        self.assertIsNone(await ws["user_id_from_ws_token"](pair["access_token"]))
        self.assertFalse(await ws["session_identity_active"](identity))

    async def test_ticket_hash_one_time_and_revoked_family_denied(self):
        import json
        pair = await self.issue()
        payload = JWT.verify_access_token(pair["access_token"])
        values, ttl = {}, {}
        class Redis:
            async def set(self, key, value, ex):
                values[key] = value
                ttl[key] = ex
            async def eval(self, script, count, key):
                return values.pop(key, None)
            async def aclose(self):
                return None
        tickets = dict(hashlib=hashlib, secrets=secrets, json=json,
                       aioredis=SimpleNamespace(from_url=lambda *a, **k: Redis()),
                       settings=SimpleNamespace(redis_url="redis://synthetic.invalid"))
        load("app/domains/auth/websocket_tickets.py", tickets)
        token = await tickets["issue_websocket_ticket"](42, payload["sid"], payload["exp"])
        self.assertTrue(all(token not in key for key in values))
        self.assertEqual(list(ttl.values()), [30])
        ws = self.websocket_runtime()
        ws["consume_websocket_ticket"] = tickets["consume_websocket_ticket"]
        identity = await ws["user_id_from_ws_token"](token)
        self.assertEqual(identity, 42)
        self.assertIsNone(await ws["user_id_from_ws_token"](token))
        token2 = await tickets["issue_websocket_ticket"](42, payload["sid"], payload["exp"])
        store = Store(self.db)
        await Lifecycle(store).revoke_all(42)
        await store.commit()
        self.assertIsNone(await ws["user_id_from_ws_token"](token2))

    async def test_open_websocket_does_not_forward_message_after_revocation(self):
        pair = await self.issue()
        ws = self.websocket_runtime()
        identity = await ws["user_id_from_ws_token"](pair["access_token"])
        store = Store(self.db)
        await Lifecycle(store).revoke_current(identity.claims)
        await store.commit()
        class Pubsub:
            async def subscribe(self, channel): pass
            async def unsubscribe(self, channel): pass
            async def aclose(self): pass
            async def listen(self):
                yield {"type": "message", "data": '{"private":"synthetic"}'}
        class Redis:
            def pubsub(self): return Pubsub()
            async def aclose(self): pass
        class Socket:
            sent = []
            closed = []
            client_state = SimpleNamespace(name="CONNECTED")
            async def close(self, **kwargs): self.closed.append(kwargs)
            async def send_text(self, data): self.sent.append(data)
            async def send_json(self, data): self.sent.append(data)
            async def receive(self): await asyncio.Event().wait()
        ws["aioredis"] = SimpleNamespace(from_url=lambda *a, **k: Redis())
        ws["settings"] = SimpleNamespace(redis_url="redis://synthetic.invalid")
        socket_fixture = Socket()
        await ws["relay_channel"](socket_fixture, "synthetic-channel", auth_identity=identity)
        self.assertEqual(socket_fixture.sent, [])
        self.assertTrue(socket_fixture.closed)
        self.assertTrue(all(value["code"] == 4001 for value in socket_fixture.closed))

    async def test_idle_socket_watch_checks_every_five_seconds(self):
        pair = await self.issue()
        ws = self.websocket_runtime()
        identity = await ws["user_id_from_ws_token"](pair["access_token"])
        sleeps = []
        async def sleep(seconds):
            sleeps.append(seconds)
            if seconds != 5:
                await asyncio.Event().wait()
            store = Store(self.db)
            await Lifecycle(store).revoke_current(identity.claims)
            await store.commit()
        ws["asyncio"] = SimpleNamespace(**{**vars(asyncio), "sleep": sleep})
        class Pubsub:
            async def subscribe(self, channel): pass
            async def unsubscribe(self, channel): pass
            async def aclose(self): pass
            async def listen(self):
                await asyncio.Event().wait()
                yield None
        class Redis:
            def pubsub(self): return Pubsub()
            async def aclose(self): pass
        class Socket:
            client_state = SimpleNamespace(name="CONNECTED")
            closed = []
            async def close(self, **kwargs): self.closed.append(kwargs)
            async def send_json(self, data): pass
            async def receive(self): await asyncio.Event().wait()
        ws["aioredis"] = SimpleNamespace(from_url=lambda *a, **k: Redis())
        ws["settings"] = SimpleNamespace(redis_url="redis://synthetic.invalid")
        socket_fixture = Socket()
        await ws["relay_channel"](socket_fixture, "synthetic-channel", auth_identity=identity)
        self.assertIn(5, sleeps)
        self.assertTrue(socket_fixture.closed)

    async def test_cancelled_relay_cleans_up_session_watch_and_redis(self):
        pair = await self.issue()
        ws = self.websocket_runtime()
        identity = await ws["user_id_from_ws_token"](pair["access_token"])
        started = asyncio.Event()
        closed = []
        class Pubsub:
            async def subscribe(self, channel): started.set()
            async def unsubscribe(self, channel): closed.append("unsubscribe")
            async def aclose(self): closed.append("pubsub")
            async def listen(self):
                await asyncio.Event().wait()
                yield None
        class Redis:
            def pubsub(self): return Pubsub()
            async def aclose(self): closed.append("redis")
        class Socket:
            client_state = SimpleNamespace(name="CONNECTED")
            async def close(self, **kwargs): pass
            async def send_json(self, data): pass
            async def receive(self): await asyncio.Event().wait()
        ws["aioredis"] = SimpleNamespace(from_url=lambda *a, **k: Redis())
        ws["settings"] = SimpleNamespace(redis_url="redis://synthetic.invalid")
        task = asyncio.create_task(ws["relay_channel"](Socket(), "synthetic-channel", auth_identity=identity))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(set(closed), {"unsubscribe", "pubsub", "redis"})
        self.assertFalse(any(t.get_name() in {"session_watch", "redis_to_ws", "ws_drain", "keepalive"}
                             for t in asyncio.all_tasks() if not t.done()))

    async def test_actual_refresh_and_logout_route_bodies(self):
        pair, other = await self.issue(), await self.issue()
        namespace = self.route_runtime()
        store = Store(self.db)
        store.add = lambda value: None
        response = await namespace["refresh_token"](SimpleNamespace(refresh_token=pair["refresh_token"], intent_nonce=None), store)
        await self.active(response.access_token)
        await namespace["logout"](SimpleNamespace(credentials=response.access_token), self.db.users[42], store)
        with self.assertRaises(Denied):
            await self.active(response.access_token)
        await self.active(other["access_token"])

    async def test_refresh_based_logout_revokes_only_current_without_rotation(self):
        pair, other = await self.issue(), await self.issue()
        route = self.route_runtime()["logout_refresh"]
        store = Store(self.db)
        store.add = lambda value: None
        result = await route(SimpleNamespace(refresh_token=pair["refresh_token"]), store)
        self.assertEqual(result["session_revocation"], "confirmed")
        with self.assertRaises(Denied):
            await self.active(pair["access_token"])
        await self.active(other["access_token"])

    async def test_logout_acknowledgement_requires_successful_commit(self):
        pair = await self.issue()
        route = self.route_runtime()["logout"]
        store = Store(self.db)
        store.add = lambda value: None
        self.db.fail_commit = True
        try:
            with self.assertRaises(RuntimeError):
                await route(SimpleNamespace(credentials=pair["access_token"]), self.db.users[42], store)
        finally:
            store.release()
        self.db.fail_commit = False
        # Revoke and acknowledge only after a successful commit.
        response = await route(SimpleNamespace(credentials=pair["access_token"]), self.db.users[42], store)
        self.assertEqual(response["session_revocation"], "confirmed")
        with self.assertRaises(Denied):
            await self.active(pair["access_token"])

    def route_runtime(self):
        tree = ast.parse((ROOT / "app/domains/auth/router.py").read_text())
        nodes = [n for n in tree.body if getattr(n, "name", None) in
                 {"refresh_token", "logout", "logout_refresh", "reset_password", "update_password"}]
        for n in nodes:
            n.decorator_list = []
            n.returns = None
            n.args.defaults = []
            for arg in n.args.args:
                arg.annotation = None
        class Column:
            def __eq__(self, other): return True
            def __gt__(self, other): return True
        class Query:
            def where(self, *args): return self
            def with_for_update(self, **kwargs): return self
            def execution_options(self, **kwargs): return self
        namespace = dict(SessionLifecycle=Lifecycle, SqlSessionFamilies=lambda db: db, subject=ns["subject"],
                         JWTUtils=JWT, HTTPException=Denied, ActivityLog=lambda **kwargs: kwargs,
                         LoginResponse=lambda **kwargs: SimpleNamespace(**kwargs),
                         UserResponse=SimpleNamespace(model_validate=lambda obj: obj),
                         User=SimpleNamespace(reset_password_token=Column(), reset_password_expires=Column()),
                         select=lambda *args: Query(), datetime=datetime,
                         ValidationException=ValueError,
                         PasswordUtils=SimpleNamespace(hash_password=lambda value: "hash:"+value,
                              verify_password=lambda value, hashed: hashed == "hash:"+value))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "auth-router-fixture", "exec"), namespace)
        return namespace

    async def test_actual_password_change_and_reset_revoke_all_families(self):
        namespace = self.route_runtime()
        for event in ("update_password", "reset_password"):
            first, second, other = await self.issue(), await self.issue(), await self.issue(99)
            store = Store(self.db)
            user = self.db.users[42]
            user.password_hash = "hash:old-fixture-password"
            user.reset_password_token = "synthetic-reset-secret"
            user.reset_password_expires = datetime.utcnow() + timedelta(minutes=1)
            store.add = lambda value: None
            async def execute(query):
                return SimpleNamespace(scalar_one_or_none=lambda: user)
            store.execute = execute
            request = SimpleNamespace(current_password="old-fixture-password", token="synthetic-reset-secret",
                                      new_password="new-fixture-password", confirm_password="new-fixture-password")
            args = (request, user, store) if event == "update_password" else (request, store)
            await namespace[event](*args)
            self.assertEqual(user.password_hash, "hash:new-fixture-password")
            for pair in (first, second):
                with self.assertRaises(Denied):
                    await self.active(pair["access_token"])
            await self.active(other["access_token"])



if __name__ == "__main__":
    unittest.main(verbosity=2)
