from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.db.dependencies import get_db
from app.models.job import Job
from app.providers.factory import ProviderFactory
from app.schemas.job import JobCreate, JobResponse
from app.workers.tasks import execute_ai_job

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post("", response_model=JobResponse)
def create_job(job: JobCreate, db: Session = Depends(get_db)):
    if not ProviderFactory.supports(job.provider):
        raise HTTPException(status_code=400, detail=f"Unsupported provider: '{job.provider}'")
    if not ProviderFactory.is_configured(job.provider):
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{job.provider}' is not configured. Set the corresponding API key in your environment.",
        )

    db_job = Job(prompt=job.prompt, provider=job.provider, model=job.model, status="pending")
    db.add(db_job)
    db.commit()
    db.refresh(db_job)
    execute_ai_job.delay(db_job.id)  # type: ignore[attr-defined]
    return db_job


@router.get("")
def get_jobs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None),
    q: str | None = Query(None),
    db: Session = Depends(get_db),
):
    query = db.query(Job)
    if status and status != "all":
        query = query.filter(Job.status == status)
    if q:
        query = query.filter(
            or_(
                Job.prompt.ilike(f"%{q}%"),
                cast(Job.id, String).like(f"%{q}%"),
            )
        )
    total = query.count()
    items = (
        query.order_by(Job.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    pages = max(1, (total + page_size - 1) // page_size)
    return {"items": items, "total": total, "page": page, "size": page_size, "pages": pages}


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    return job
