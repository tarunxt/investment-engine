# AI Infrastructure Agent Rules

You are operating inside a production-grade AI infrastructure platform.

The project uses:

- Frontend: Next.js
- Backend: FastAPI
- Queue: Redis
- Workers: Celery
- Database: PostgreSQL
- Containerization: Docker

---

# Core Architecture

Frontend
→ FastAPI API
→ PostgreSQL
→ Redis Queue
→ Celery Worker
→ AI Provider
→ Store Results
→ Return Response

---

## Database Migrations (Alembic)

### Rules

* Run Alembic only inside Docker backend container.
* Every schema change requires a migration.
* All models must be imported in `app/models/__init__.py`.

Example:

```python id="mcb9jd"
from .job import Job
```

`alembic/env.py`:

```python id="h65ov8"
from app.models import *
```

---

## Create Migration

```bash id="5cujkt"
docker exec -it investor-backend-1 alembic revision --autogenerate -m "message"
```

Apply:

```bash id="o2r5kt"
docker exec -it investor-backend-1 alembic upgrade head
```

Rollback:

```bash id="2dr73o"
docker exec -it investor-backend-1 alembic downgrade -1
```

---

## Verify Models Detected

```bash id="2oc0oq"
docker exec -it investor-backend-1 python -c \
"from app.db.database import Base; import app.models; print(Base.metadata.tables.keys())"
```

---

## Fix Broken Migration State (dev only)

Delete migrations:

```bash id="rk2xkj"
find alembic/versions -name "*.py" -delete
```

Reset Alembic DB state:

```bash id="jx7l7x"
docker exec -it investor-postgres-1 psql -U aiuser -d aidb
```

```sql id="0d3nkt"
DROP TABLE IF EXISTS alembic_version;
```

Recreate:

```bash id="9n5cp9"
docker exec -it investor-backend-1 alembic revision --autogenerate -m "initial"
docker exec -it investor-backend-1 alembic upgrade head
```

---

## Notes

* Inside Docker DB host = `postgres`
* Outside Docker DB host = `localhost`


# STRICT RULES

## 1. NEVER BREAK EXISTING APIs

Before modifying:
- routes
- schemas
- models
- worker logic

You MUST inspect current implementation first.

Avoid:
- renaming fields
- removing fields
- changing response shapes
- changing endpoint behavior

Backward compatibility is mandatory.

---

# 2. NEVER USE SYNCHRONOUS AI EXECUTION

ALL AI operations MUST execute through:

Redis Queue
→ Celery Worker

Forbidden:
- direct OpenAI calls inside FastAPI routes
- blocking requests
- long-running HTTP requests

Correct:

API
→ queue task
→ worker executes

---

# 3. ALL DATABASE OPERATIONS MUST USE SQLALCHEMY

Forbidden:
- raw SQL unless absolutely necessary
- inline database connections
- duplicated sessions

Use:
- SessionLocal
- dependency injection
- models

---

# 4. ALL NEW TABLE CHANGES REQUIRE MIGRATIONS

Never manually alter production tables.

Use:
- Alembic migrations

Development reset is allowed only in MVP stage.

---

# 5. NEVER HARDCODE API KEYS

Always use:
- .env
- environment variables

Forbidden:
- hardcoded secrets
- committing keys
- embedding credentials in frontend

---

# 6. ALL AI PROVIDERS MUST USE ABSTRACTION LAYER

Never directly call providers in business logic.

Correct:

ProviderFactory
→ OpenAIProvider
→ AnthropicProvider
→ GeminiProvider

Every provider must return normalized response:

```python
{
    "content": "...",
    "tokens_in": 0,
    "tokens_out": 0,
    "cost": 0,
    "provider": "openai",
    "model": "gpt-4o-mini"
}
```

---

# 7. ALL TASKS MUST BE RETRY SAFE

Workers must:
- handle failures
- avoid duplicate side effects
- update job status correctly

Required states:
- pending
- processing
- completed
- failed

---

# 8. NEVER STORE LARGE RAW RESPONSES WITHOUT NEED

Store:
- normalized text
- metadata
- tokens
- cost

Avoid:
- giant payloads
- duplicated raw JSON

---

# 9. ALL SERVICES MUST REMAIN DOCKER COMPATIBLE

Every change must work inside Docker.

Never assume:
- localhost networking
- local Python installs
- local node installs

Use container names:
- postgres
- redis
- backend

---

# 10. NEVER MIX RESPONSIBILITIES

FastAPI:
- APIs
- validation
- orchestration

Celery:
- execution
- AI processing
- retries

Frontend:
- UI only

---

# 11. ALL LONG TASKS REQUIRE TIMEOUTS

Celery tasks must define:
- retry policy
- timeout
- failure handling

---

# 12. ALWAYS LOG FAILURES

Failures must:
- update DB status
- store error message
- log traceback

Silent failures are forbidden.

---

# 13. COST TRACKING IS MANDATORY

Track:
- input tokens
- output tokens
- latency
- retries
- provider
- model
- estimated cost

---

# 14. DO NOT BUILD MONOLITHIC FILES

Split logic into:
- routes
- services
- providers
- workers
- schemas
- models

Avoid giant files.

---

# 15. ALL NEW FEATURES MUST FOLLOW THIS FLOW

Schema
→ Model
→ Route
→ Service
→ Worker
→ Frontend

Do not skip layers.

---

# 16. NEVER TRUST FRONTEND INPUT

Validate:
- prompts
- model names
- providers
- schedules
- IDs

Always validate through Pydantic.

---

# 17. DO NOT BLOCK THE EVENT LOOP

FastAPI routes must remain lightweight.

Heavy work belongs in workers only.

---

# 18. MAINTAIN CLEAN PROJECT STRUCTURE

backend/
├── api/
├── core/
├── db/
├── models/
├── providers/
├── schemas/
├── services/
├── workers/

frontend/
├── app/
├── components/
├── services/
├── hooks/

---

# 19. ALL CODE MUST BE PRODUCTION MINDED

Every implementation should consider:
- scalability
- retries
- observability
- fault tolerance
- queue safety
- DB consistency

---

# 20. PREFERRED DEVELOPMENT ORDER

1. Backend models
2. API routes
3. Queue integration
4. Worker execution
5. AI provider integration
6. Cost tracking
7. Frontend UI
8. Analytics
9. Scheduling
10. Scaling

---

# 21. NEVER IMPLEMENT MAGIC LOGIC

All behavior must be:
- explicit
- traceable
- debuggable

Avoid hidden side effects.

---

# 22. REQUIRED STACK

Frontend:
- Next.js
- Tailwind
- shadcn/ui

Backend:
- FastAPI
- SQLAlchemy
- Celery
- Redis
- PostgreSQL

Deployment:
- Docker
- Docker Compose

---

# 23. ALWAYS THINK DISTRIBUTED

Assume:
- multiple workers
- retries
- queue duplication
- partial failures
- container restarts

Code must remain safe under distributed execution.

---

# 24. NEVER DELETE USER DATA AUTOMATICALLY

No destructive operations without explicit logic.

---

# 25. ALL CHANGES MUST PRESERVE SYSTEM STABILITY

Priority order:

1. Stability
2. Reliability
3. Scalability
4. Performance
5. Features

Never sacrifice stability for speed.