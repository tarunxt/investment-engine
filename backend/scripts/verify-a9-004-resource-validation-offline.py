#!/usr/bin/env python3
"""A9-004: real schema/use-case bodies with synthetic, pre-import egress guards.

Does not prove PostgreSQL admission/concurrency or any paid provider limit.
"""
import os
import socket
import subprocess


def deny(*args, **kwargs):
    raise AssertionError("A9-004 offline proof forbids network/process egress")


for owner, names in ((socket, ("create_connection", "getaddrinfo")),
                     (socket.socket, ("connect", "connect_ex", "sendto")),
                     (subprocess, ("Popen",)),
                     (os, ("system", "fork", "posix_spawn", "posix_spawnp"))):
    for name in names:
        if hasattr(owner, name):
            setattr(owner, name, deny)

# No application startup, settings, database, queue or providers imported.
import ast
import math
import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
import unittest
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from fastapi import FastAPI
import httpx

ROOT = Path(__file__).resolve().parents[1]


def execute_nodes(path, namespace, names=None):
    tree = ast.parse((ROOT / path).read_text())
    nodes = [n for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom))]
    if names is not None:
        nodes = [n for n in nodes if getattr(n, "name", None) in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), path, "exec"), namespace)


namespace = dict(dataclass=dataclass, field=field, math=math)
execute_nodes("app/shared/exceptions.py", namespace)
execute_nodes("app/domains/jobs/resource_validation.py", namespace)
execute_nodes("app/domains/jobs/resource_policy.py", namespace)
validate = namespace["validate_model_identifiers"]
Invalid = namespace["ValidationException"]
LIMIT = namespace["MODEL_IDENTIFIER_MAX_CHARS"]
source_tree = ast.parse((ROOT / "app/domains/jobs/output_sources.py").read_text())
source_count = next(ast.literal_eval(n.value) for n in source_tree.body
                    if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "MAX_OUTPUT_SOURCE_JOBS" for t in n.targets))
models = dict(BaseModel=BaseModel, Field=Field, Optional=Optional, datetime=datetime,
              Any=Any, field_validator=field_validator, model_validator=model_validator,
              AuditRunContext=Any, PolymarketEventRunContext=Any, OutputSourceJobReference=Any,
              MAX_OUTPUT_SOURCE_JOBS=source_count,
              MODEL_IDENTIFIER_MAX_CHARS=LIMIT, MAX_PROMPT_CHARS=namespace["MAX_PROMPT_CHARS"],
              MAX_TARGETS=namespace["MAX_TARGETS"], validate_prompt=namespace["validate_prompt"],
              ValidationException=Invalid)
execute_nodes("app/domains/jobs/schemas.py", models, {"JobCreate"})
execute_nodes("app/domains/runs/schemas.py", models, {"RunModelTarget", "RunCreate"})


class AfterValidation(Exception):
    pass


def actual_execute(path, class_name, after):
    tree = ast.parse((ROOT / path).read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
    method = next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "execute")
    method.returns = None
    for arg in method.args.args:
        arg.annotation = None
    # Isolate the unchanged authorization and new validation prefix from DB/queue
    # dependencies; the injected stop is AFTER the actual validation statements.
    allowed = {"require_equity_analysis", "validate_prompt", "validate_targets", "validate_model_identifiers"}
    prefix = []
    for node in method.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id in allowed:
            prefix.append(node)
        elif isinstance(node, ast.For) and all(isinstance(child, ast.Expr) and isinstance(child.value, ast.Call) and isinstance(child.value.func, ast.Name) and child.value.func.id == "validate_model_identifiers" for child in node.body):
            prefix.append(node)
        else:
            break
    method.body = prefix + ast.parse("after_validation()").body
    ast.fix_missing_locations(method)
    ns = dict(validate_model_identifiers=validate, require_equity_analysis=lambda *args: None,
              after_validation=after, validate_prompt=namespace["validate_prompt"], validate_targets=namespace["validate_targets"])
    exec(compile(ast.Module(body=[method], type_ignores=[]), path, "exec"), ns)
    return ns["execute"]


class ResourceProof(unittest.TestCase):
    def test_limit_matches_existing_database_columns(self):
        tree = ast.parse((ROOT / "app/domains/jobs/models.py").read_text())
        job = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Job")
        for name in ("provider", "model"):
            column = next(n for n in job.body if isinstance(n, ast.AnnAssign) and n.target.id == name)
            string = next(n for n in ast.walk(column.value) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "String")
            self.assertEqual(ast.literal_eval(string.args[0]), LIMIT)
            self.assertEqual(LIMIT, 100)

    def test_boundaries_preserve_characters_case_whitespace_and_empty_semantics(self):
        for value in ("", "X" * 99, "X" * 100, "界" * 100, "e\u0301" * 50, " Model-Case " * 8):
            for field_name in ("provider", "model"):
                kwargs = {"provider": "fixture", "model": "fixture-model", field_name: value}
                validate(**kwargs)
                for name in ("JobCreate", "RunModelTarget"):
                    schema_kwargs = {**kwargs, **({"prompt": "preserve synthetic prompt"} if name == "JobCreate" else {})}
                    obj = models[name](**schema_kwargs)
                    self.assertEqual(getattr(obj, field_name), value)
        self.assertEqual(len(("界" * 100).encode()), 300)  # Not a 100-byte cap.

    def test_http_schema_rejects_oversized_metadata_before_handler(self):
        for schema_name in ("JobCreate", "RunModelTarget"):
            for field_name in ("provider", "model"):
                for value in ("x" * 101, "界" * 101, "synthetic-private-" * 100000):
                    kwargs = {"provider": "fixture", "model": "fixture-model", field_name: value}
                    if schema_name == "JobCreate": kwargs["prompt"] = "synthetic prompt"
                    with self.assertRaises(ValidationError): models[schema_name](**kwargs)

    def test_actual_http_routes_deny_oversize_before_provider_selection(self):
        async def exercise():
            for path, function_name, schema_name in (
                ("app/domains/jobs/router.py", "create_job", "JobCreate"),
                ("app/domains/runs/router.py", "create_run", "RunCreate"),
            ):
                calls = []
                def provider_boundary(*args):
                    calls.append("provider-selection")
                    raise AfterValidation
                ns = {schema_name: models[schema_name],
                      "ProviderFactory": SimpleNamespace(supports=provider_boundary)}
                tree = ast.parse((ROOT / path).read_text())
                fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == function_name)
                fn.decorator_list = []
                fn.returns = None
                for arg in fn.args.args:
                    if arg.arg != "body": arg.annotation = None
                fn.args.defaults = [ast.Constant(None)] * (len(fn.args.args) - 1)
                exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), path, "exec"), ns)
                app = FastAPI()
                app.post("/synthetic")(ns[function_name])
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://offline.invalid") as client:
                    for field_name in ("provider", "model"):
                        item = {"provider": "fixture", "model": "fixture-model", field_name: "界" * 101}
                        payload = {"prompt": "synthetic", **item} if schema_name == "JobCreate" else {"prompt": "synthetic", "targets": [item]}
                        response = await client.post("/synthetic", json=payload)
                        self.assertEqual(response.status_code, 422)
                        self.assertEqual(calls, [])
                    valid = {"provider": "fixture", "model": "fixture-model"}
                    payload = {"prompt": "synthetic", **valid} if schema_name == "JobCreate" else {"prompt": "synthetic", "targets": [valid]}
                    with self.assertRaises(AfterValidation): await client.post("/synthetic", json=payload)
                    self.assertEqual(calls, ["provider-selection"])
        asyncio.run(exercise())

    def test_direct_commands_reject_before_all_admission_side_effects(self):
        for path, class_name, is_run in (
            ("app/domains/jobs/use_cases/create_job.py", "CreateJobUseCase", False),
            ("app/domains/runs/use_cases/create_run.py", "CreateRunUseCase", True),
        ):
            reached = []
            def after(*args):
                reached.append("after-validation")
                raise AfterValidation
            execute = actual_execute(path, class_name, after)
            for field_name in ("provider", "model"):
                for value in ("x" * 101, "界" * 101, None, True, [], {}):
                    target = SimpleNamespace(provider="fixture", model="fixture-model")
                    setattr(target, field_name, value)
                    command = SimpleNamespace(prompt="synthetic", auto_rebalance_portfolio=None, polymarket_event_context=None, **vars(target), targets=[SimpleNamespace(provider="valid", model="valid"), target])
                    # self and policy/DB/Redis/queue/provider dependencies remain
                    # absent: any access beyond the guard makes this fail.
                    with self.assertRaises(Invalid) as error:
                        asyncio.run(execute(None, command))
                    self.assertEqual(error.exception.status_code, 422)
                    self.assertEqual(reached, [])
                    self.assertNotIn(str(value), error.exception.message)

    def test_valid_direct_commands_reach_original_first_boundary_unchanged(self):
        for path, cls, command in (
            ("app/domains/jobs/use_cases/create_job.py", "CreateJobUseCase", SimpleNamespace(prompt="synthetic", provider="P" * 100, model="界" * 100, auto_rebalance_portfolio=None)),
            ("app/domains/runs/use_cases/create_run.py", "CreateRunUseCase", SimpleNamespace(prompt="synthetic", targets=[SimpleNamespace(provider="P" * 100, model="界" * 100)], auto_rebalance_portfolio=None, polymarket_event_context=None)),
        ):
            calls = []
            def boundary(*args):
                calls.append(args)
                raise AfterValidation
            with self.assertRaises(AfterValidation): asyncio.run(actual_execute(path, cls, boundary)(None, command))
            self.assertEqual(len(calls), 1)

    def test_error_metadata_is_bounded_and_does_not_echo_identifier(self):
        value = "synthetic-private-identifier" * 10000
        with self.assertRaises(Invalid) as error: validate(value, "valid")
        self.assertEqual(error.exception.details, {"field": "provider", "max_length": 100})
        self.assertNotIn("synthetic-private", error.exception.message)
        self.assertLess(len(error.exception.message), 100)

    def test_repeated_targets_and_prompt_content_are_not_rewritten(self):
        values = [("openai", "gpt-4o-mini"), ("deepseek", "deepseek-chat"), ("openai", "gpt-4o-mini"), ("OpenAI", "GPT-4O-MINI"), ("deepseek", "deepseek-coder")]
        targets = [models["RunModelTarget"](provider=p, model=m) for p, m in values]
        self.assertEqual([(t.provider, t.model) for t in targets], values)
        run = models["RunCreate"](prompt="Swing Scan", targets=targets)
        self.assertEqual([(t.provider, t.model) for t in run.targets], values)
        prompt = "synthetic unicode 界 and financial units ₹ unchanged\n" * 100
        self.assertEqual(models["JobCreate"](prompt=prompt, provider="fixture", model="model").prompt, prompt)

    def test_guards_remain_active(self):
        for action in (lambda: socket.getaddrinfo("example.invalid", 443), lambda: subprocess.Popen(["true"]), lambda: os.system("true")):
            with self.assertRaises(AssertionError): action()


if __name__ == "__main__":
    unittest.main(verbosity=2)
