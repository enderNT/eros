# Referencia del Esquema de Base de Datos

## Convenciones

Esta referencia documenta el esquema real `public` junto con las migraciones propietarias definidas en el código del proyecto.

Los tipos se muestran usando los nombres que devuelve PostgreSQL en `information_schema.columns`.

## Store de LangGraph

### `store`

Guarda documentos JSON identificados por namespace y clave.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`prefix`, `key`) |
| Responsable principal | `langgraph.store.postgres` |
| Índices importantes | `store_pkey`, `store_prefix_idx`, `idx_store_expires_at` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `prefix` | `text` | No |  |
| `key` | `text` | No |  |
| `value` | `jsonb` | No |  |
| `created_at` | `timestamp with time zone` | Yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamp with time zone` | Yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamp with time zone` | Yes |  |
| `ttl_minutes` | `integer` | Yes |  |

Notas:

- `prefix` es el namespace serializado usado por LangGraph.
- `value` guarda el documento JSON completo.
- El soporte TTL es opcional y se representa con `expires_at` y `ttl_minutes`.

### `store_vectors`

Guarda embeddings vectoriales para campos indexados desde `store`.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`prefix`, `key`, `field_name`) |
| Foreign key | (`prefix`, `key`) -> `store(prefix, key)` |
| Responsable principal | `langgraph.store.postgres` |
| Índices importantes | `store_vectors_pkey`, `store_vectors_embedding_idx` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `prefix` | `text` | No |  |
| `key` | `text` | No |  |
| `field_name` | `text` | No |  |
| `embedding` | `vector` | Yes |  |
| `created_at` | `timestamp with time zone` | Yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamp with time zone` | Yes | `CURRENT_TIMESTAMP` |

Notas:

- `field_name` identifica el campo indexado dentro del documento JSON.
- El entorno actual usa un índice HNSW con operadores coseno: `store_vectors_embedding_idx`.

### `store_migrations`

Registra las migraciones aplicadas para las tablas del store.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | `v` |
| Responsable principal | `langgraph.store.postgres` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `v` | `integer` | No |  |

### `vector_migrations`

Registra las migraciones específicas del subsistema vectorial.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | `v` |
| Responsable principal | `langgraph.store.postgres` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `v` | `integer` | No |  |

## Checkpoints de LangGraph

### `checkpoints`

Guarda snapshots de checkpoint por hilo y namespace.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`thread_id`, `checkpoint_ns`, `checkpoint_id`) |
| Responsable principal | `langgraph.checkpoint.postgres` |
| Índices importantes | `checkpoints_pkey`, `checkpoints_thread_id_idx` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `thread_id` | `text` | No |  |
| `checkpoint_ns` | `text` | No | `''::text` |
| `checkpoint_id` | `text` | No |  |
| `parent_checkpoint_id` | `text` | Yes |  |
| `type` | `text` | Yes |  |
| `checkpoint` | `jsonb` | No |  |
| `metadata` | `jsonb` | No | `'{}'::jsonb` |

Notas:

- `checkpoint` contiene el snapshot serializado del estado.
- `metadata` guarda metadatos serializados adicionales del saver.

### `checkpoint_blobs`

Guarda blobs de canal para versiones de canales de checkpoint.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`thread_id`, `checkpoint_ns`, `channel`, `version`) |
| Responsable principal | `langgraph.checkpoint.postgres` |
| Índices importantes | `checkpoint_blobs_pkey`, `checkpoint_blobs_thread_id_idx` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `thread_id` | `text` | No |  |
| `checkpoint_ns` | `text` | No | `''::text` |
| `channel` | `text` | No |  |
| `version` | `text` | No |  |
| `type` | `text` | No |  |
| `blob` | `bytea` | Yes |  |

Notas:

- `blob` puede ser nulo cuando LangGraph registra un valor de canal vacío.
- Las filas se resuelven usando la información de canal/versión guardada dentro de `checkpoints.checkpoint`.

### `checkpoint_writes`

Guarda escrituras pendientes asociadas a un checkpoint.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`thread_id`, `checkpoint_ns`, `checkpoint_id`, `task_id`, `idx`) |
| Responsable principal | `langgraph.checkpoint.postgres` |
| Índices importantes | `checkpoint_writes_pkey`, `checkpoint_writes_thread_id_idx` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `thread_id` | `text` | No |  |
| `checkpoint_ns` | `text` | No | `''::text` |
| `checkpoint_id` | `text` | No |  |
| `task_id` | `text` | No |  |
| `idx` | `integer` | No |  |
| `channel` | `text` | No |  |
| `type` | `text` | Yes |  |
| `blob` | `bytea` | No |  |
| `task_path` | `text` | No | `''::text` |

Notas:

- `task_path` forma parte de la metadata de ordenamiento del runtime.
- `blob` guarda payloads serializados de escrituras pendientes.

### `checkpoint_migrations`

Registra las migraciones aplicadas al subsistema de checkpoints.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | `v` |
| Responsable principal | `langgraph.checkpoint.postgres` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `v` | `integer` | No |  |

## Trazas de la aplicación

### `trace_turns`

Registro principal de un turno trazado.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | `trace_id` |
| Clave única | `dedupe_key` |
| Responsable principal | `app.tracing.repository.PostgresTraceRepository` |
| Índices importantes | `trace_turns_pkey`, `trace_turns_dedupe_key_key`, `idx_trace_turns_session_key`, `idx_trace_turns_actor_key`, `idx_trace_turns_flow_key`, `idx_trace_turns_started_at`, `idx_trace_turns_outcome` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `trace_id` | `text` | No |  |
| `parent_trace_id` | `text` | Yes |  |
| `session_key` | `text` | No |  |
| `actor_key` | `text` | No |  |
| `app_key` | `text` | No |  |
| `flow_key` | `text` | No |  |
| `dedupe_key` | `text` | Yes |  |
| `started_at` | `timestamp with time zone` | No |  |
| `completed_at` | `timestamp with time zone` | Yes |  |
| `component_version` | `text` | Yes |  |
| `model_backend` | `text` | Yes |  |
| `model_name` | `text` | Yes |  |
| `outcome` | `text` | No |  |
| `has_error` | `boolean` | No | `false` |
| `projector_eligibility_summary` | `jsonb` | No | `'{}'::jsonb` |
| `input_payload` | `jsonb` | No | `'{}'::jsonb` |
| `output_payload` | `jsonb` | No | `'{}'::jsonb` |
| `error_payload` | `jsonb` | No | `'{}'::jsonb` |
| `metrics_payload` | `jsonb` | No | `'{}'::jsonb` |
| `tags` | `jsonb` | No | `'{}'::jsonb` |
| `extra_payload` | `jsonb` | No | `'{}'::jsonb` |

Notas:

- `session_key` es la clave de agrupación a nivel conversación.
- `actor_key` identifica al contacto o actor.
- `dedupe_key` evita inserts duplicados del mismo evento lógico.

### `trace_fragments`

Guarda fragmentos ordenados capturados durante un turno.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`trace_id`, `order`) |
| Foreign key | `trace_id` -> `trace_turns(trace_id)` |
| Responsable principal | `app.tracing.repository.PostgresTraceRepository` |
| Índices importantes | `trace_fragments_pkey` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `trace_id` | `text` | No |  |
| `order` | `integer` | No |  |
| `kind` | `text` | No |  |
| `label` | `text` | No | `''::text` |
| `created_at` | `timestamp with time zone` | No |  |
| `latency_ms` | `integer` | Yes |  |
| `token_usage` | `jsonb` | No | `'{}'::jsonb` |
| `payload` | `jsonb` | No | `'{}'::jsonb` |

Notas:

- `order` preserva la secuencia de fragmentos dentro de un turno.
- `kind` identifica el tipo lógico del fragmento, por ejemplo routing o retrieval.

### `trace_examples`

Guarda ejemplos proyectados derivados de turnos trazados.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`trace_id`, `task_name`, `projector_version`) |
| Foreign key | `trace_id` -> `trace_turns(trace_id)` |
| Responsable principal | `app.tracing.repository.PostgresTraceRepository` |
| Índices importantes | `trace_examples_pkey` |

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `trace_id` | `text` | No |  |
| `task_name` | `text` | No |  |
| `projector_version` | `text` | No |  |
| `created_at` | `timestamp with time zone` | No |  |
| `split` | `text` | No | `'train'::text` |
| `quality_label` | `text` | Yes |  |
| `input_payload` | `jsonb` | No | `'{}'::jsonb` |
| `target_payload` | `jsonb` | No | `'{}'::jsonb` |
| `metadata_payload` | `jsonb` | No | `'{}'::jsonb` |
| `eligibility_reason` | `text` | No | `''::text` |

Notas:

- `task_name` agrupa ejemplos proyectados por tarea.
- `projector_version` permite que la misma traza produzca múltiples proyecciones versionadas de forma independiente.

## Resumen de constraints

### Foreign keys declaradas

| Constraint | Tabla | Referencia |
| --- | --- | --- |
| `store_vectors_prefix_key_fkey` | `store_vectors` | `store(prefix, key)` |
| `trace_fragments_trace_id_fkey` | `trace_fragments` | `trace_turns(trace_id)` |
| `trace_examples_trace_id_fkey` | `trace_examples` | `trace_turns(trace_id)` |

### Constraints únicas

| Constraint | Tabla | Columnas |
| --- | --- | --- |
| `trace_turns_dedupe_key_key` | `trace_turns` | `dedupe_key` |

## Resumen de índices

| Tabla | Índice | Definición |
| --- | --- | --- |
| `store` | `store_prefix_idx` | `btree (prefix text_pattern_ops)` |
| `store` | `idx_store_expires_at` | `btree (expires_at) WHERE expires_at IS NOT NULL` |
| `store_vectors` | `store_vectors_embedding_idx` | `hnsw (embedding vector_cosine_ops)` |
| `checkpoints` | `checkpoints_thread_id_idx` | `btree (thread_id)` |
| `checkpoint_blobs` | `checkpoint_blobs_thread_id_idx` | `btree (thread_id)` |
| `checkpoint_writes` | `checkpoint_writes_thread_id_idx` | `btree (thread_id)` |
| `trace_turns` | `idx_trace_turns_session_key` | `btree (session_key)` |
| `trace_turns` | `idx_trace_turns_actor_key` | `btree (actor_key)` |
| `trace_turns` | `idx_trace_turns_flow_key` | `btree (flow_key)` |
| `trace_turns` | `idx_trace_turns_started_at` | `btree (started_at)` |
| `trace_turns` | `idx_trace_turns_outcome` | `btree (outcome)` |
