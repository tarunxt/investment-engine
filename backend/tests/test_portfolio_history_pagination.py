"""Run the real route's SQL against an isolated SQLite fixture, without app/providers."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, func, select
from sqlalchemy.orm import Session


def route_fixture():
    metadata = MetaData()
    tables = {}
    for name, sequence in (("workflow", "sequence"), ("run", "auto_rebalance_sequence"), ("job", "auto_rebalance_sequence")):
        portfolio = "portfolio" if name == "workflow" else "auto_rebalance_portfolio"
        tables[name] = Table(name, metadata, Column("user_id", Integer), Column(portfolio, String), Column(sequence, Integer))
    engine = create_engine("sqlite://")
    metadata.create_all(engine)
    session = Session(engine)

    class Database:
        async def execute(self, statement):
            return session.execute(statement)

    calls = []

    async def build(db, *, user_id, portfolio, sequences):
        calls.append((user_id, portfolio, sequences))
        return [(sequence, [], []) for sequence in sorted(sequences, reverse=True)]

    tree = ast.parse((Path(__file__).parents[1] / "app/domains/runs/router.py").read_text())
    route = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "list_auto_rebalance_history")
    route.decorator_list = []
    route.args.defaults = []
    for arg in route.args.args:
        arg.annotation = None
    route.returns = None
    namespace = {"select": select, "func": func, "AutoRebalanceWorkflow": tables["workflow"].c,
                 "Run": tables["run"].c, "Job": tables["job"].c, "_build_auto_rebalance_history": build,
                 "AutoRebalanceHistoryListResponse": lambda **values: SimpleNamespace(**values)}
    exec(compile(ast.Module(body=[route], type_ignores=[]), "history-route", "exec"), namespace)
    return namespace["list_auto_rebalance_history"], Database(), session, tables, calls


def test_history_paginates_union_of_verified_legacy_and_workflow_sequences():
    route, db, session, tables, calls = route_fixture()
    session.execute(tables["workflow"].insert(), [{"user_id": 7, "portfolio": "india", "sequence": n} for n in range(1, 252)])
    session.execute(tables["run"].insert(), [
        {"user_id": 7, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 252},
        {"user_id": 7, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 252},  # retry
        {"user_id": 8, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 999},
        {"user_id": 7, "auto_rebalance_portfolio": "indmoney_us", "auto_rebalance_sequence": 888},
        {"user_id": 7, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": None},
    ])
    session.execute(tables["job"].insert(), [{"user_id": 7, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 253}])
    first = asyncio.run(route(0, "india", 250, db, SimpleNamespace(id=7)))
    second = asyncio.run(route(250, "india", 250, db, SimpleNamespace(id=7)))
    empty = asyncio.run(route(500, "india", 250, db, SimpleNamespace(id=7)))
    assert first.total == second.total == empty.total == 253
    assert first.items == list(range(253, 3, -1))
    assert second.items == [3, 2, 1]
    assert empty.items == []
    assert calls[-1][2] == set(), "empty pages must not fall back to all history"
    assert all(owner == 7 and market == "india" for owner, market, _ in calls)
    us = asyncio.run(route(0, "indmoney_us", 20, db, SimpleNamespace(id=7)))
    assert us.total == 1 and us.items == [888]
    other_owner = asyncio.run(route(0, "india", 20, db, SimpleNamespace(id=8)))
    assert other_owner.total == 1 and other_owner.items == [999]
