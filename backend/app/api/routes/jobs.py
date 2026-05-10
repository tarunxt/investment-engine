from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.dependencies import get_db
from app.models.job import Job
from app.providers.factory import ProviderFactory
from app.schemas.job import JobCreate, JobResponse
from app.workers.tasks import execute_ai_job

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post(
    "",
    response_model=JobResponse
)
def create_job(
    job: JobCreate,
    db: Session = Depends(get_db)
):
    if not ProviderFactory.supports(job.provider):
        raise HTTPException(status_code=400, detail=f"Unsupported provider: '{job.provider}'")
    if not ProviderFactory.is_configured(job.provider):
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{job.provider}' is not configured. Set the corresponding API key in your environment."
        )

    db_job = Job(
        prompt=job.prompt,
        provider=job.provider,
        model=job.model,
        status="pending"
    )

    db.add(db_job)

    db.commit()

    db.refresh(db_job)

    execute_ai_job.delay(db_job.id) # type: ignore[attr-defined]

    return db_job

@router.get("")
def get_jobs(
    db: Session = Depends(get_db)
):
    jobs = db.query(Job).all()

    return jobs


@router.get("/{job_id}")
def get_job(
    job_id: int,
    db: Session = Depends(get_db)
):
    job = db.query(Job).filter(Job.id == job_id).first()

    return job