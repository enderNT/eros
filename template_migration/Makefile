PYTHON ?= python3
DSPY_HOST ?= 0.0.0.0
DSPY_PORT ?= 8001

.PHONY: dspy
dspy:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python -m uvicorn app:app --app-dir dspy_service --host $(DSPY_HOST) --port $(DSPY_PORT) --reload
