# ──────────────────────────────────────────────────────────────────────────
# FastAPI Backend Image
# ──────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ARG BULLPEN_VERSION=0.1.101

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

RUN curl -fsSL https://cli.bullpen.fi/install.sh -o /tmp/install-bullpen.sh && \
    chmod +x /tmp/install-bullpen.sh && \
    BULLPEN_VERSION=${BULLPEN_VERSION} BULLPEN_INSTALL_DIR=/usr/local/bin /tmp/install-bullpen.sh && \
    rm /tmp/install-bullpen.sh && \
    /usr/local/bin/bullpen --version

# Copy application
COPY --chown=appuser:appuser . .

RUN mkdir -p /home/appuser/.bullpen && \
    chown -R appuser:appuser $VIRTUAL_ENV /home/appuser/.bullpen

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

# Run with uvicorn in development, switch to gunicorn for production if needed
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
