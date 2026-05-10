from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.db.dependencies import get_db
from app.core.logging import get_logger
from app.core.exceptions import HealthCheckException
import redis
from app.core.config import settings

router = APIRouter(prefix="/health", tags=["health"])
logger = get_logger(__name__)


@router.get("")
async def health_check() -> dict:
    """
    Overall health check.
    Returns status of all critical services.
    """
    return {
        "status": "ok",
        "message": "AI Investment Platform Backend is running"
    }


@router.get("/db")
async def health_check_db(db: Session = Depends(get_db)) -> dict:
    """
    Database health check.
    Verifies PostgreSQL connection.
    """
    try:
        db.execute(text("SELECT 1"))
        logger.info("Database health check: OK")
        return {
            "status": "ok",
            "service": "database",
            "message": "Database connection healthy"
        }
    except Exception as e:
        logger.error(f"Database health check failed: {str(e)}")
        raise HealthCheckException("database", str(e))


@router.get("/redis")
async def health_check_redis() -> dict:
    """
    Redis health check.
    Verifies Redis connection.
    """
    try:
        r = redis.from_url(settings.redis_url)
        r.ping()
        logger.info("Redis health check: OK")
        return {
            "status": "ok",
            "service": "redis",
            "message": "Redis connection healthy"
        }
    except Exception as e:
        logger.error(f"Redis health check failed: {str(e)}")
        raise HealthCheckException("redis", str(e))


@router.get("/full")
async def health_check_full(db: Session = Depends(get_db)) -> dict:
    """
    Full health check.
    Verifies all critical services.
    """
    results = {
        "status": "ok",
        "services": {}
    }
    
    # Check database
    try:
        db.execute(text("SELECT 1"))
        results["services"]["database"] = {"status": "ok"}
    except Exception as e:
        results["status"] = "degraded"
        results["services"]["database"] = {"status": "error", "error": str(e)}
        logger.error(f"Database health check failed: {str(e)}")
    
    # Check Redis
    try:
        r = redis.from_url(settings.redis_url)
        r.ping()
        results["services"]["redis"] = {"status": "ok"}
    except Exception as e:
        results["status"] = "degraded"
        results["services"]["redis"] = {"status": "error", "error": str(e)}
        logger.error(f"Redis health check failed: {str(e)}")
    
    if results["status"] == "ok":
        logger.info("Full health check: All services OK")
    else:
        logger.warning(f"Full health check: Degraded - {results['services']}")
    
    return results
