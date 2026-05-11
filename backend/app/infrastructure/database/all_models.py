# Import every ORM model so SQLAlchemy's mapper registry is fully populated
# before any query runs. Required in Celery workers (which don't load main.py).
from app.domains.auth.models import User, UserProfile, UserSession, APIKey, ActivityLog  # noqa: F401
from app.domains.jobs.models import Job  # noqa: F401
from app.domains.prompts.models import Prompt  # noqa: F401
from app.infrastructure.database.outbox.models import OutboxMessage  # noqa: F401
