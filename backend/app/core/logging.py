import logging
import logging.config
from app.core.config import settings
import json
from datetime import datetime


# Structured logging configuration
LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        },
        "detailed": {
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s() - %(message)s"
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "level": "DEBUG",
            "formatter": "detailed",
            "stream": "ext://sys.stdout"
        },
        "file": {
            "class": "logging.handlers.RotatingFileHandler",
            "level": "INFO",
            "formatter": "detailed",
            "filename": "logs/app.log",
            "maxBytes": 10485760,  # 10MB
            "backupCount": 5
        },
        "worker_file": {
            "class": "logging.handlers.RotatingFileHandler",
            "level": "INFO",
            "formatter": "detailed",
            "filename": "logs/worker.log",
            "maxBytes": 10485760,  # 10MB
            "backupCount": 5
        }
    },
    "loggers": {
        "uvicorn": {
            "handlers": ["console"],
            "level": settings.log_level,
            "propagate": False
        },
        "uvicorn.access": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False
        },
        "app": {
            "handlers": ["console", "file"],
            "level": settings.log_level,
            "propagate": False
        },
        "app.workers": {
            "handlers": ["console", "worker_file"],
            "level": settings.log_level,
            "propagate": False
        },
        "sqlalchemy.engine": {
            "handlers": ["console"],
            "level": "WARNING",
            "propagate": False
        },
        "celery": {
            "handlers": ["console", "worker_file"],
            "level": settings.log_level,
            "propagate": False
        }
    },
    "root": {
        "level": settings.log_level,
        "handlers": ["console", "file"]
    }
}


def configure_logging() -> None:
    """Configure application logging."""
    try:
        import os
        os.makedirs("logs", exist_ok=True)
    except Exception as e:
        print(f"Warning: Could not create logs directory: {e}")
    
    logging.config.dictConfig(LOGGING_CONFIG)
    logger = logging.getLogger("app")
    logger.info(f"Logging configured - Level: {settings.log_level}")


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance."""
    return logging.getLogger(name)


# Request logging middleware helper
class LoggingMiddlewareHelper:
    """Helper class for request/response logging."""
    
    @staticmethod
    def log_request(method: str, path: str, user_id: str = None) -> None:
        """Log incoming request."""
        logger = get_logger("app.api")
        logger.info(
            f"Request: {method} {path}",
            extra={"user_id": user_id} if user_id else {}
        )
    
    @staticmethod
    def log_response(method: str, path: str, status_code: int, duration_ms: float) -> None:
        """Log outgoing response."""
        logger = get_logger("app.api")
        level = "info" if 200 <= status_code < 300 else "warning"
        
        getattr(logger, level)(
            f"Response: {method} {path} - {status_code} ({duration_ms:.2f}ms)"
        )
    
    @staticmethod
    def log_error(error_type: str, message: str, traceback: str = None) -> None:
        """Log error."""
        logger = get_logger("app.error")
        logger.error(f"{error_type}: {message}")
        if traceback:
            logger.error(f"Traceback: {traceback}")


# Worker logging helper
class WorkerLogHelper:
    """Helper class for worker logging."""
    
    @staticmethod
    def log_task_start(task_name: str, task_id: str, job_id: int = None) -> None:
        """Log task execution start."""
        logger = get_logger("app.workers")
        logger.info(f"Task started: {task_name} (ID: {task_id}, Job: {job_id})")
    
    @staticmethod
    def log_task_complete(task_name: str, task_id: str, duration_ms: float, job_id: int = None) -> None:
        """Log task execution complete."""
        logger = get_logger("app.workers")
        logger.info(f"Task completed: {task_name} (ID: {task_id}, Job: {job_id}, Duration: {duration_ms:.2f}ms)")
    
    @staticmethod
    def log_task_error(task_name: str, task_id: str, error: str, job_id: int = None) -> None:
        """Log task execution error."""
        logger = get_logger("app.workers")
        logger.error(f"Task failed: {task_name} (ID: {task_id}, Job: {job_id}) - Error: {error}")
