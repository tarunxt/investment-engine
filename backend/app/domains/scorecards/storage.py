"""Store independent analysis revisions in the existing workflow-stage ledger.

An ordinary stage name identifies a visible lifecycle slot. The reserved prefix
identifies a versioned analysis document. The ledger supplies a durable integer
ID, a workflow FK, a run FK, timestamps and unique (workflow, stage) keys.
"""
from dataclasses import dataclass
from hashlib import sha256
from sqlalchemy import select
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow, AutoRebalanceWorkflowStage as Stage


@dataclass(frozen=True)
class Document:
    row: Stage

    @property
    def id(self):
        return self.row.id

    @property
    def data(self):
        return self.row.summary_json

    @property
    def manifest(self):
        return self.data["manifest"]

    @property
    def digest(self):
        return self.data["digest"]

    @property
    def result_json(self):
        return self.data.get("result")


def prefix(kind, revision_id=None):
    code = {"revision": "r", "attempt": "a", "final": "f", "packet": "p", "pair_work": "w"}[kind]
    return "sc1." + code + "." + (f"{revision_id:x}." if revision_id is not None else "")


def stage_key(kind, identity, revision_id=None):
    start = prefix(kind, revision_id)
    suffix = sha256(identity.encode()).hexdigest()
    return start + suffix[:32-len(start)]


def of_kind(kind, revision_id=None):
    return Stage.stage.startswith(prefix(kind, revision_id))


async def lookup(db, uid, portfolio, kind, record_id, *, sequence=None, lock=False):
    query = select(Stage).join(Workflow).where(
        Stage.id == record_id, of_kind(kind), Workflow.user_id == uid, Workflow.portfolio == portfolio)
    if sequence is not None:
        query = query.where(Workflow.sequence == sequence)
    if lock:
        query = query.with_for_update(of=Stage)
    row = await db.scalar(query)
    return Document(row) if row else None


async def by_key(db, kind, identity, *, workflow_id=None, revision_id=None):
    query = select(Stage).where(Stage.stage == stage_key(kind, identity, revision_id))
    if workflow_id is not None:
        query = query.where(Stage.workflow_id == workflow_id)
    row = await db.scalar(query)
    if row and row.summary_json["identity"] != identity:
        raise ValueError("Analysis document key collision")
    return Document(row) if row else None


async def append(db, workflow_id, kind, identity, payload, *, revision_id=None):
    row = Stage(workflow_id=workflow_id, stage=stage_key(kind, identity, revision_id),
                status="processing" if kind=="attempt" else "completed",
                summary_json={"identity": identity, "revision_id": revision_id, **payload})
    db.add(row)
    await db.flush()
    return Document(row)


async def latest_final(db, uid, portfolio, sequence=None):
    query = select(Stage).join(Workflow).where(of_kind("final"), Workflow.user_id==uid, Workflow.portfolio==portfolio)
    if sequence is not None:
        query = query.where(Workflow.sequence==sequence)
    row = await db.scalar(query.order_by(Stage.id.desc()).limit(1))
    return Document(row) if row else None
