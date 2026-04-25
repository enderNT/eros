import { Client } from "pg";

type TraceRow = {
  request_json: string;
  response_json: string | null;
  ok: boolean;
};

type DatasetExample = {
  input: unknown;
  output?: unknown;
};

function assertIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceScalarString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }

  if (/^null$/i.test(trimmed)) {
    return null;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return value;
}

function deepNormalize(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return deepNormalize(JSON.parse(trimmed));
      } catch {
        return coerceScalarString(value);
      }
    }

    return coerceScalarString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepNormalize(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, deepNormalize(nestedValue)])
    );
  }

  return value;
}

function parsePayload(text: string | null, label: string): unknown {
  if (!text) {
    throw new Error(`Missing ${label} payload`);
  }

  return deepNormalize(JSON.parse(text));
}

function toDatasetExample(row: TraceRow): DatasetExample {
  const example: DatasetExample = {
    input: parsePayload(row.request_json, "request_json")
  };

  if (row.ok && row.response_json) {
    example.output = parsePayload(row.response_json, "response_json");
  }

  return example;
}

async function listTaskTables(client: Client, schema: string): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `
      select table_name
      from information_schema.tables
      where table_schema = $1
        and table_type = 'BASE TABLE'
        and table_name like '%\\_calls'
      order by table_name
    `,
    [schema]
  );

  return result.rows.map((row) => row.table_name);
}

async function loadTraceRows(client: Client, schema: string, tableName: string): Promise<TraceRow[]> {
  const schemaId = quoteIdentifier(assertIdentifier(schema, "schema"));
  const tableId = quoteIdentifier(assertIdentifier(tableName, "table"));
  const result = await client.query<TraceRow>(
    `
      select request_json, response_json, ok
      from ${schemaId}.${tableId}
      order by started_at, completed_at, endpoint, id
    `
  );

  return result.rows;
}

async function writeDatasetFile(outputPath: string, rows: TraceRow[]): Promise<void> {
  const lines = rows.map((row) => JSON.stringify(toDatasetExample(row)));
  await Bun.write(outputPath, lines.length ? `${lines.join("\n")}\n` : "");
}

async function main(): Promise<void> {
  const outputDir = process.argv[2] || process.env.DSPY_TASK_EXPORT_DIR || "exports/dspy_task_traces";
  const connectionString = process.env.DSPY_TASK_TRACE_POSTGRES_URL || process.env.TRACE_POSTGRES_URL || "";
  const schema = assertIdentifier(process.env.DSPY_TASK_TRACE_POSTGRES_SCHEMA || "dspy_task_traces", "schema");

  if (!connectionString) {
    throw new Error("Missing DSPY task trace connection string. Set DSPY_TASK_TRACE_POSTGRES_URL or TRACE_POSTGRES_URL.");
  }

  await Bun.$`mkdir -p ${outputDir}`.quiet();

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: Number(process.env.DSPY_TASK_TRACE_POSTGRES_CONNECT_TIMEOUT_MS || "3000"),
    statement_timeout: Number(process.env.DSPY_TASK_TRACE_POSTGRES_QUERY_TIMEOUT_MS || "5000"),
    query_timeout: Number(process.env.DSPY_TASK_TRACE_POSTGRES_QUERY_TIMEOUT_MS || "5000"),
    keepAlive: false,
    application_name: "eros-dspy-dataset-export"
  });

  await client.connect();

  try {
    const tables = await listTaskTables(client, schema);
    if (!tables.length) {
      console.error(`No DSPy task trace tables were found in schema ${schema}.`);
      return;
    }

    let totalRows = 0;

    for (const tableName of tables) {
      const taskName = tableName.replace(/_calls$/, "");
      const rows = await loadTraceRows(client, schema, tableName);
      const outputPath = `${outputDir}/${taskName}.jsonl`;
      await writeDatasetFile(outputPath, rows);
      totalRows += rows.length;
      console.log(`Exported ${taskName}: ${rows.length} rows -> ${outputPath}`);
    }

    console.log(`Done. Exported ${tables.length} DSPy task datasets (${totalRows} rows total) to ${outputDir}`);
  } finally {
    await client.end();
  }
}

await main();
