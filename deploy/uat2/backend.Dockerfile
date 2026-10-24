FROM python:3.13-slim-bookworm
ARG UAT2_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$UAT2_SOURCE_COMMIT
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home appuser
COPY --chown=10001:10001 backend/ .
RUN mkdir -p /backend/data && chown 10001:10001 /backend/data
USER 10001:10001
CMD ["uvicorn", "app.uat2.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
