"""Read only saved outputs from one workflow and Stage 2 revision."""
from sqlalchemy import Integer, cast, func, select
from sqlalchemy.dialects.postgresql import JSONB
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from . import storage
from .storage import Stage


def summary(card, rows):
    if card == "technical":
        return sum(r.get("score") is not None for r in rows),len(rows)
    # Each verdict appears once on each side of its pair.
    return sum(r.get("valid",0) for r in rows)//2, len(rows)*(len(rows)-1)//2


async def available(db, owner, portfolio, sequence):
    def scoped(*cols):
        return select(*cols).select_from(Stage).join(Workflow).where(
            Workflow.user_id==owner, Workflow.portfolio==portfolio, Workflow.sequence==sequence)
    rev = await db.scalar(scoped(Stage.id).where(storage.of_kind("revision")).order_by(Stage.id.desc()).limit(1))
    attempt_revision = await db.scalar(scoped(Stage.summary_json["revision_id"].as_integer())
                            .where(storage.of_kind("attempt")).order_by(Stage.id.desc()).limit(1))
    rev=max((i for i in (rev,attempt_revision) if i),default=None)
    if not rev:
        return {"revision_id":None,"cards":{}}
    data = Stage.summary_json
    final = (await db.execute(scoped(Stage.id,data["result"]["attempts"]).where(storage.of_kind("final"))
                             .order_by(Stage.id.desc()).limit(1))).first()
    rows_expr = data["result"]["rows"]
    postgres = db.get_bind().dialect.name=="postgresql"
    if postgres:
        # Aggregate historical JSON on the server. The dashboard never needs raw responses.
        arr=func.jsonb_array_elements(cast(rows_expr,JSONB)).table_valued("value").alias("stock")
        valid=select(func.sum(cast(cast(arr.c.value,JSONB)["valid"].as_string(),Integer))).select_from(arr).correlate(Stage).scalar_subquery()
        projections=[func.jsonb_array_length(cast(rows_expr,JSONB)),data["result"]["scored"].as_integer(),valid]
    else:
        projections=[rows_expr]
    items = (await db.execute(scoped(Stage.id,Stage.run_id,data["card"].as_string(),*projections)
             .where(storage.of_kind("attempt",rev),data["card"].as_string().in_(["technical","pairwise"]))
             .order_by(Stage.id.desc()))).all()
    cards = {}
    for output,run,card,*info in items:
        if not info[0]:
            continue
        if postgres:
            n,scored,judgments=info
            got,total=(scored or 0,n) if card=="technical" else ((judgments or 0)//2,n*(n-1)//2)
        else:
            got,total=summary(card,info[0])
        if card in cards and cards[card]["covered"]>=got:
            continue
        cards[card] = {"output_id":output,"run_id":run,"covered":got,"expected":total,
                       "used_output_id":(final[1] or {}).get(card) if final else None,"final_id":final[0] if final else None}
    return {"revision_id":rev,"cards":cards}
