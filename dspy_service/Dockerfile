FROM python:3.12-slim

WORKDIR /service
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt \
    && python -c "import dspy; print('dspy import ok')"

COPY app.py ./
COPY modules.py ./
COPY service_logging.py ./
COPY signatures.py ./
COPY datasets ./datasets
COPY artifacts ./artifacts

EXPOSE 8001

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
