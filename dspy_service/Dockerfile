FROM python:3.12-slim

WORKDIR /service
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

RUN python - <<'PY'
import traceback

try:
    import dspy
    print("dspy import ok")
except Exception:
    traceback.print_exc()
    raise
PY

COPY app.py ./
COPY modules.py ./
COPY service_logging.py ./
COPY signatures.py ./
COPY datasets ./datasets
COPY artifacts ./artifacts

EXPOSE 8001

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
