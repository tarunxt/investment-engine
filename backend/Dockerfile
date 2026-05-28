# ──────────────────────────────────────────────────────────────────────────
# FastAPI Backend Image
# ──────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Create virtual environment
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Create non-root user
RUN useradd -m appuser

WORKDIR /backend

# Copy and install requirements
COPY requirements.txt .

RUN pip install --upgrade pip --index-url https://pypi.org/simple/ --trusted-host pypi.org --timeout 100 && \
    pip install --no-cache-dir -r requirements.txt --index-url https://pypi.org/simple/ --trusted-host pypi.org --timeout 100 && \
    pip install --no-cache-dir gunicorn[gevent]

# Copy application
COPY --chown=appuser:appuser . .

RUN chown -R appuser:appuser $VIRTUAL_ENV

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

# Run with uvicorn in development, switch to gunicorn for production if needed
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
