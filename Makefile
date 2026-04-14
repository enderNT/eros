PYTHON ?= python3
DSPY_HOST ?= 0.0.0.0
DSPY_PORT ?= 8001

.PHONY: dspy dspy-optimize dspy-optimize-conversation dspy-optimize-rag dspy-optimize-state-router
dspy:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python -m uvicorn app:app --app-dir dspy_service --host $(DSPY_HOST) --port $(DSPY_PORT) --reload

dspy-optimize:
	@test -n "$(TASK)" || (echo "Missing TASK. Use: make dspy-optimize TASK=conversation_reply|rag_reply|state_router" && exit 1)
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_task.py $(TASK)

dspy-optimize-conversation:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_conversation_reply.py

dspy-optimize-rag:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_rag.py

dspy-optimize-state-router:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv ./.venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_state_router.py
