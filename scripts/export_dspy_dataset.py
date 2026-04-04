from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from app.dspy import PostgresDSPyDatasetStore
from app.settings import Settings


async def _run() -> int:
    parser = argparse.ArgumentParser(description="Export DSPy-ready datasets from trace tables.")
    parser.add_argument("--output-dir", default="exports/dspy", help="Directory where JSONL files will be written.")
    parser.add_argument("--task", action="append", dest="tasks", help="Specific task name to export. Repeatable.")
    parser.add_argument("--limit", type=int, default=None, help="Optional max number of examples to export.")
    args = parser.parse_args()

    settings = Settings()
    if settings.dspy_dataset_backend != "postgres":
        raise RuntimeError("Only the postgres DSPy dataset backend is currently supported.")
    if not settings.trace_postgres_dsn:
        raise RuntimeError("`trace_postgres_dsn` is required to export DSPy datasets.")

    store = PostgresDSPyDatasetStore(settings.trace_postgres_dsn, schema=settings.trace_postgres_schema)
    written = await store.export_jsonl(
        Path(args.output_dir),
        task_names=args.tasks,
        limit=args.limit,
    )
    for task_name, file_path in sorted(written.items()):
        print(f"{task_name}: {file_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
