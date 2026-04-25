PYTHON ?= python3
DSPY_HOST ?= 0.0.0.0
DSPY_PORT ?= 8001
DSPY_TASK ?=
DSPY_AUTO ?= light
DSPY_MAX_BOOTSTRAPPED_DEMOS ?= 4
DSPY_MAX_LABELED_DEMOS ?= 4
DSPY_NUM_THREADS ?=

.PHONY: dspy dspy-compile dspy-compile-conversation dspy-compile-rag dspy-compile-state-router dspy-optimize dspy-optimize-conversation dspy-optimize-rag dspy-optimize-state-router
dspy:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python -m uvicorn app:app --app-dir dspy_service --host $(DSPY_HOST) --port $(DSPY_PORT) --reload

dspy-compile:
	@test -n "$(DSPY_TASK)" || (echo "Missing DSPY_TASK. Use: make dspy-compile DSPY_TASK=conversation_reply|rag_reply|state_router [DSPY_AUTO=medium] [DSPY_MAX_BOOTSTRAPPED_DEMOS=4] [DSPY_MAX_LABELED_DEMOS=4] [DSPY_NUM_THREADS=4]" && exit 1)
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_task.py $(DSPY_TASK) --auto $(DSPY_AUTO) --max-bootstrapped-demos $(DSPY_MAX_BOOTSTRAPPED_DEMOS) --max-labeled-demos $(DSPY_MAX_LABELED_DEMOS) $(if $(DSPY_NUM_THREADS),--num-threads $(DSPY_NUM_THREADS),)

dspy-compile-conversation:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_task.py conversation_reply --auto $(DSPY_AUTO) --max-bootstrapped-demos $(DSPY_MAX_BOOTSTRAPPED_DEMOS) --max-labeled-demos $(DSPY_MAX_LABELED_DEMOS) $(if $(DSPY_NUM_THREADS),--num-threads $(DSPY_NUM_THREADS),)

dspy-compile-rag:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_task.py rag_reply --auto $(DSPY_AUTO) --max-bootstrapped-demos $(DSPY_MAX_BOOTSTRAPPED_DEMOS) --max-labeled-demos $(DSPY_MAX_LABELED_DEMOS) $(if $(DSPY_NUM_THREADS),--num-threads $(DSPY_NUM_THREADS),)

dspy-compile-state-router:
	@test -x .venv/bin/python || (echo "Missing .venv. Create it with: python3 -m venv ./.venv && ./.venv/bin/pip install -r dspy_service/requirements.txt" && exit 1)
	./.venv/bin/python dspy_service/optimize_task.py state_router --auto $(DSPY_AUTO) --max-bootstrapped-demos $(DSPY_MAX_BOOTSTRAPPED_DEMOS) --max-labeled-demos $(DSPY_MAX_LABELED_DEMOS) $(if $(DSPY_NUM_THREADS),--num-threads $(DSPY_NUM_THREADS),)

dspy-optimize: dspy-compile

dspy-optimize-conversation: dspy-compile-conversation

dspy-optimize-rag: dspy-compile-rag

dspy-optimize-state-router: dspy-compile-state-router

run_export_and_norm: bun run export:dspy-datasets
