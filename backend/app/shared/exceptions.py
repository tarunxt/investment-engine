from dataclasses import dataclass, field


@dataclass
class AppException(Exception):
    """Base application exception. Maps to a structured HTTP response."""
    message: str
    code: str = "APP_ERROR"
    status_code: int = 500
    details: dict = field(default_factory=dict)


class ValidationException(AppException):
    def __init__(self, message: str, details: dict | None = None):
        super().__init__(
            message=message,
            code="VALIDATION_ERROR",
            status_code=422,
            details=details or {},
        )


class NotFoundException(AppException):
    def __init__(self, message: str = "Resource not found"):
        super().__init__(message=message, code="NOT_FOUND", status_code=404)


class ForbiddenException(AppException):
    def __init__(self, message: str = "Access denied"):
        super().__init__(message=message, code="FORBIDDEN", status_code=403)


class ConflictException(AppException):
    def __init__(self, message: str = "Resource already exists"):
        super().__init__(message=message, code="CONFLICT", status_code=409)
