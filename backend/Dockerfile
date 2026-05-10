FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv $VIRTUAL_ENV

ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN useradd -m appuser

WORKDIR /backend

COPY requirements.txt .

# Upgrade pip and install requirements using PyPI with timeout
RUN pip install --upgrade pip --index-url https://pypi.org/simple/ --trusted-host pypi.org --timeout 100 && \
    pip install --no-cache-dir -r requirements.txt --index-url https://pypi.org/simple/ --trusted-host pypi.org --timeout 100

COPY --chown=appuser:appuser . .

RUN chown -R appuser:appuser $VIRTUAL_ENV

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]