from scripts.prepare_trace_postgres import TracePostgresConfig, build_postgres_dsn, redact_dsn_password


def test_build_postgres_dsn_encodes_password_and_defaults():
    dsn = build_postgres_dsn(
        TracePostgresConfig(
            host="localhost",
            port=5432,
            database="eros",
            user="tester",
            password="s3cr et",
            schema="tracing",
            sslmode="prefer",
        )
    )

    assert "s3cr%20et" in dsn
    assert dsn.endswith("/eros?sslmode=prefer")


def test_redact_dsn_password_hides_secret():
    redacted = redact_dsn_password("postgresql://tester:supersecret@localhost:5432/eros?sslmode=prefer")

    assert "supersecret" not in redacted
    assert "tester:***@" in redacted
