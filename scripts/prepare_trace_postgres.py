from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from getpass import getpass
import json
from pathlib import Path
import sys
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.tracing.repository import PostgresTraceRepository, _validate_schema_name


@dataclass(slots=True)
class TracePostgresConfig:
    host: str = "localhost"
    port: int = 5432
    database: str = ""
    user: str = ""
    password: str = ""
    schema: str = "tracing"
    sslmode: str = "prefer"


def build_postgres_dsn(config: TracePostgresConfig) -> str:
    if not config.database.strip():
        raise ValueError("Database is required.")
    if not config.user.strip():
        raise ValueError("User is required.")
    _validate_schema_name(config.schema)
    user = quote(config.user.strip(), safe="")
    password = quote(config.password, safe="")
    host = config.host.strip() or "localhost"
    return f"postgresql://{user}:{password}@{host}:{int(config.port)}/{config.database.strip()}?sslmode={config.sslmode.strip() or 'prefer'}"


def redact_dsn_password(dsn: str) -> str:
    parts = urlsplit(dsn)
    if "@" not in parts.netloc:
        return dsn
    credentials, host = parts.netloc.rsplit("@", 1)
    username = credentials.split(":", 1)[0]
    return urlunsplit((parts.scheme, f"{username}:***@{host}", parts.path, parts.query, parts.fragment))


async def prepare_trace_database(dsn: str, *, schema: str) -> dict[str, Any]:
    repository = PostgresTraceRepository(dsn, schema=schema)
    await repository.setup()
    return await inspect_trace_catalog(dsn, schema=schema)


async def inspect_trace_catalog(dsn: str, *, schema: str) -> dict[str, Any]:
    from psycopg import AsyncConnection
    from psycopg.rows import dict_row

    async with await AsyncConnection.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema = %s
                  AND table_name IN ('trace_turns', 'trace_fragments', 'trace_examples')
                ORDER BY table_name
                """,
                (schema,),
            )
            tables = [dict(row) for row in await cur.fetchall()]
            await cur.execute(
                """
                SELECT schemaname, tablename, indexname
                FROM pg_indexes
                WHERE schemaname = %s
                  AND tablename IN ('trace_turns', 'trace_fragments', 'trace_examples')
                ORDER BY tablename, indexname
                """,
                (schema,),
            )
            indexes = [dict(row) for row in await cur.fetchall()]
    return {"schema": schema, "tables": tables, "indexes": indexes}


def _prompt(label: str, default: str = "", *, secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    prompt = f"{label}{suffix}: "
    if secret:
        value = getpass(prompt)
    else:
        value = input(prompt)
    return value if value else default


def prompt_trace_postgres_config() -> TracePostgresConfig:
    host = _prompt("PostgreSQL host", "localhost")
    port = int(_prompt("PostgreSQL port", "5432"))
    database = _prompt("Database")
    user = _prompt("User")
    password = _prompt("Password", secret=True)
    schema = _validate_schema_name(_prompt("Tracing schema", "tracing"))
    sslmode = _prompt("SSL mode", "prefer")
    return TracePostgresConfig(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        schema=schema,
        sslmode=sslmode,
    )


async def _main() -> int:
    config = prompt_trace_postgres_config()
    dsn = build_postgres_dsn(config)
    catalog = await prepare_trace_database(dsn, schema=config.schema)
    output = {
        "connection": {
            **{key: value for key, value in asdict(config).items() if key != "password"},
            "dsn": redact_dsn_password(dsn),
        },
        "catalog": catalog,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
