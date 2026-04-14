import { Client } from "pg";
import type { AppSettings } from "../../config";
import type { GraphState } from "../../domain/contracts";
import type { ClinicStateStore, HealthStatus } from "../../domain/ports";

function createClient(settings: AppSettings): Client {
  return new Client({
    connectionString: settings.trace.postgres.connectionString,
    connectionTimeoutMillis: settings.trace.postgres.connectTimeoutMs,
    statement_timeout: settings.trace.postgres.queryTimeoutMs,
    query_timeout: settings.trace.postgres.queryTimeoutMs,
    keepAlive: false,
    application_name: `${settings.trace.appKey}-state`
  });
}

export class PostgresClinicStateStore implements ClinicStateStore {
  private readonly checkpointId = "latest";

  constructor(private readonly settings: AppSettings) {}

  async load(sessionId: string): Promise<GraphState | null> {
    if (!this.settings.trace.postgres.connectionString) {
      throw new Error("TRACE_POSTGRES_URL is required when STATE_BACKEND=postgres");
    }

    const client = createClient(this.settings);
    try {
      await client.connect();
      const result = await client.query<{ checkpoint: GraphState }>(
        `select checkpoint
         from public.checkpoints
         where thread_id = $1
           and checkpoint_ns = $2
           and checkpoint_id = $3
         limit 1`,
        [sessionId, this.settings.state.checkpointNamespace, this.checkpointId]
      );

      return result.rows[0]?.checkpoint ?? null;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async save(sessionId: string, state: GraphState): Promise<void> {
    if (!this.settings.trace.postgres.connectionString) {
      throw new Error("TRACE_POSTGRES_URL is required when STATE_BACKEND=postgres");
    }

    const client = createClient(this.settings);
    try {
      await client.connect();
      await client.query(
        `insert into public.checkpoints (
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          parent_checkpoint_id,
          type,
          checkpoint,
          metadata
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        on conflict (thread_id, checkpoint_ns, checkpoint_id)
        do update set
          parent_checkpoint_id = excluded.parent_checkpoint_id,
          type = excluded.type,
          checkpoint = excluded.checkpoint,
          metadata = excluded.metadata`,
        [
          sessionId,
          this.settings.state.checkpointNamespace,
          this.checkpointId,
          null,
          "graph_state",
          JSON.stringify(state),
          JSON.stringify({
            app_key: this.settings.trace.appKey,
            updated_at: new Date().toISOString()
          })
        ]
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async health(): Promise<HealthStatus> {
    if (!this.settings.trace.postgres.connectionString) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          reason: "missing_connection_string"
        }
      };
    }

    const client = createClient({
      ...this.settings,
      trace: {
        ...this.settings.trace,
        postgres: {
          ...this.settings.trace.postgres,
          queryTimeoutMs: this.settings.trace.postgres.healthTimeoutMs
        }
      }
    });

    try {
      await client.connect();
      await client.query(
        `select 1
         from public.checkpoints
         where checkpoint_ns = $1
         limit 1`,
        [this.settings.state.checkpointNamespace]
      );
      return {
        ok: true,
        details: {
          backend: "postgres",
          checkpoint_namespace: this.settings.state.checkpointNamespace
        }
      };
    } catch (error) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          checkpoint_namespace: this.settings.state.checkpointNamespace,
          error: error instanceof Error ? error.message : "unknown_error"
        }
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async close(_timeoutMs?: number): Promise<void> {
    return;
  }
}
