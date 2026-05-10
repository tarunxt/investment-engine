from fastapi import HTTPException, status
from typing import Any, Dict, Optional


class AppException(Exception):
    """Base application exception."""
    
    def __init__(
        self,
        message: str,
        code: str = "INTERNAL_ERROR",
        status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR,
        details: Optional[Dict[str, Any]] = None
    ):
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details or {}
        super().__init__(self.message)


class ValidationException(AppException):
    """Raised when validation fails."""
    
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            message=message,
            code="VALIDATION_ERROR",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details=details
        )


class NotFoundException(AppException):
    """Raised when resource is not found."""
    
    def __init__(self, message: str, resource: str = "Resource"):
        super().__init__(
            message=message,
            code="NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"resource": resource}
        )


class UnauthorizedException(AppException):
    """Raised when authentication fails."""
    
    def __init__(self, message: str = "Unauthorized"):
        super().__init__(
            message=message,
            code="UNAUTHORIZED",
            status_code=status.HTTP_401_UNAUTHORIZED
        )


class ForbiddenException(AppException):
    """Raised when user lacks permissions."""
    
    def __init__(self, message: str = "Forbidden"):
        super().__init__(
            message=message,
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN
        )


class WorkerException(AppException):
    """Raised when worker execution fails."""
    
    def __init__(self, message: str, job_id: Optional[int] = None):
        super().__init__(
            message=message,
            code="WORKER_ERROR",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            details={"job_id": job_id}
        )


class HealthCheckException(AppException):
    """Raised when health check fails."""
    
    def __init__(self, service: str, message: str):
        super().__init__(
            message=f"{service} health check failed: {message}",
            code="HEALTH_CHECK_FAILED",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            details={"service": service}
        )


def exception_to_http(exc: AppException) -> HTTPException:
    """Convert AppException to HTTPException."""
    return HTTPException(
        status_code=exc.status_code,
        detail={
            "error": exc.code,
            "message": exc.message,
            "details": exc.details
        }
    )
