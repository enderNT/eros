# Referencia de Consultas de Base de Datos

## Propósito

Este documento reúne consultas de inspección útiles para explorar el esquema PostgreSQL actual y sus datos de runtime.

## Inventario del esquema

### Listar tablas de la aplicación

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'store',
    'store_migrations',
    'store_vectors',
    'vector_migrations',
    'checkpoints',
    'checkpoint_blobs',
    'checkpoint_writes',
    'checkpoint_migrations',
    'trace_turns',
    'trace_fragments',
    'trace_examples'
  )
ORDER BY table_name;
```

### Listar columnas y tipos

```sql
SELECT
  table_name,
  ordinal_position,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'store',
    'store_migrations',
    'store_vectors',
    'vector_migrations',
    'checkpoints',
    'checkpoint_blobs',
    'checkpoint_writes',
    'checkpoint_migrations',
    'trace_turns',
    'trace_fragments',
    'trace_examples'
  )
ORDER BY table_name, ordinal_position;
```

### Listar índices

```sql
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'store',
    'store_vectors',
    'checkpoints',
    'checkpoint_blobs',
    'checkpoint_writes',
    'trace_turns',
    'trace_fragments',
    'trace_examples'
  )
ORDER BY tablename, indexname;
```

## Inspección del store

### Entradas recientes del store

```sql
SELECT
  prefix,
  key,
  created_at,
  updated_at,
  expires_at,
  ttl_minutes,
  value
FROM store
ORDER BY updated_at DESC NULLS LAST
LIMIT 50;
```

### Entradas de memoria por namespace

```sql
SELECT
  prefix,
  COUNT(*) AS items,
  MIN(created_at) AS first_seen,
  MAX(updated_at) AS last_seen
FROM store
GROUP BY prefix
ORDER BY items DESC, prefix;
```

### Ítems del store con vectores

```sql
SELECT
  s.prefix,
  s.key,
  sv.field_name,
  s.updated_at,
  s.value
FROM store AS s
JOIN store_vectors AS sv
  ON sv.prefix = s.prefix
 AND sv.key = s.key
ORDER BY s.updated_at DESC NULLS LAST
LIMIT 50;
```

## Inspección de checkpoints

### Últimos checkpoints por hilo

```sql
SELECT
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  parent_checkpoint_id,
  type,
  metadata,
  checkpoint
FROM checkpoints
ORDER BY thread_id, checkpoint_id DESC
LIMIT 100;
```

### Hilos con más checkpoints

```sql
SELECT
  thread_id,
  COUNT(*) AS checkpoints,
  MAX(checkpoint_id) AS latest_checkpoint_id
FROM checkpoints
GROUP BY thread_id
ORDER BY checkpoints DESC, thread_id;
```

### Escrituras pendientes por checkpoint

```sql
SELECT
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  task_id,
  task_path,
  idx,
  channel,
  type
FROM checkpoint_writes
ORDER BY thread_id, checkpoint_id DESC, task_path, task_id, idx
LIMIT 100;
```

### Versiones de blobs por hilo

```sql
SELECT
  thread_id,
  checkpoint_ns,
  channel,
  version,
  type
FROM checkpoint_blobs
ORDER BY thread_id, channel, version DESC
LIMIT 100;
```

## Inspección de trazas

### Turnos recientes

```sql
SELECT
  trace_id,
  session_key,
  actor_key,
  flow_key,
  started_at,
  completed_at,
  outcome,
  has_error,
  dedupe_key
FROM trace_turns
ORDER BY started_at DESC
LIMIT 100;
```

### Errores recientes

```sql
SELECT
  trace_id,
  session_key,
  started_at,
  outcome,
  error_payload
FROM trace_turns
WHERE has_error = TRUE
ORDER BY started_at DESC
LIMIT 50;
```

### Turno con sus fragmentos

```sql
SELECT
  t.trace_id,
  t.session_key,
  t.started_at,
  f."order",
  f.kind,
  f.label,
  f.latency_ms,
  f.payload
FROM trace_turns AS t
LEFT JOIN trace_fragments AS f
  ON f.trace_id = t.trace_id
WHERE t.trace_id = $1
ORDER BY f."order";
```

### Fragmentos por tipo

```sql
SELECT
  kind,
  COUNT(*) AS total,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM trace_fragments
GROUP BY kind
ORDER BY total DESC, kind;
```

### Ejemplos proyectados recientes

```sql
SELECT
  trace_id,
  task_name,
  projector_version,
  split,
  quality_label,
  created_at,
  eligibility_reason
FROM trace_examples
ORDER BY created_at DESC
LIMIT 100;
```

### Join entre turnos y ejemplos

```sql
SELECT
  t.trace_id,
  t.session_key,
  t.started_at,
  e.task_name,
  e.projector_version,
  e.input_payload,
  e.target_payload,
  e.metadata_payload
FROM trace_examples AS e
JOIN trace_turns AS t
  ON t.trace_id = e.trace_id
ORDER BY e.created_at DESC
LIMIT 100;
```

## Verificaciones de catálogo

### Foreign keys

```sql
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.table_schema = ccu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
```

### Extensiones instaladas

```sql
SELECT extname
FROM pg_extension
ORDER BY extname;
```
