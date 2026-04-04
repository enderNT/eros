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

Las tablas de tracing viven en el schema dedicado `tracing` por defecto. Ese schema se configura con `trace_postgres_schema` y lo usan tanto `PostgresTraceRepository` como `PostgresDSPyDatasetStore`.

### `tracing.trace_turns`

Registro principal de un turno trazado.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | `trace_id` |
| Clave única | `dedupe_key` |
| Responsable principal | `app.tracing.repository.PostgresTraceRepository` |
| Índices importantes | `trace_turns_pkey`, `trace_turns_dedupe_key_key`, `idx_trace_turns_session_key`, `idx_trace_turns_actor_key`, `idx_trace_turns_flow_key`, `idx_trace_turns_started_at`, `idx_trace_turns_outcome` |

### `tracing.trace_fragments`

Guarda fragmentos ordenados capturados durante un turno. Para datasets, los fragmentos relevantes son `conversation_reply_input`, `conversation_reply_output`, `rag_reply_input`, `rag_reply_output`, `appointment_reply_input` y `appointment_reply_output`.

### `tracing.trace_examples`

Guarda ejemplos proyectados derivados de turnos trazados.

| Propiedad | Valor |
| --- | --- |
| Clave primaria | (`trace_id`, `task_name`, `projector_version`) |
| Foreign key | `trace_id` -> `tracing.trace_turns(trace_id)` |
| Responsable principal | `app.tracing.repository.PostgresTraceRepository` |
| Índices importantes | `trace_examples_pkey`, `idx_trace_examples_task_version_created_at` |

Notas:

- En esta fase solo se almacenan datasets para `conversation_reply`, `rag_reply` y `appointment_reply`.
- `input_payload` guarda el JSON estructurado exacto disponible en producción.
- `target_payload` guarda solo `response_text`.
- `metadata_payload` guarda metadatos operativos como `node` y `reply_mode`.

## Payloads esperados

### `conversation_reply`

```json
{
  "input_payload": {
    "user_message": "Quiero saber si ofrecen terapia",
    "summary": "Usuario pide informacion general.",
    "active_goal": "conversation",
    "stage": "open",
    "pending_question": "",
    "last_assistant_message": "Hola, soy Eros Bot.",
    "recent_turns": [
      {
        "user": "Hola",
        "assistant": "Hola, soy Eros Bot."
      }
    ],
    "memories": [
      "Prefiere respuestas breves"
    ]
  },
  "target_payload": {
    "response_text": "Claro, puedo orientarte sobre los servicios de la clinica."
  },
  "metadata_payload": {
    "node": "conversation",
    "reply_mode": "llm"
  }
}
```

### `rag_reply`

```json
{
  "input_payload": {
    "user_message": "Cuales son sus horarios?",
    "summary": "Usuario pregunta por informacion operativa.",
    "active_goal": "information",
    "stage": "lookup",
    "pending_question": "",
    "last_assistant_message": "Con gusto reviso eso.",
    "recent_turns": [],
    "memories": [
      "Ya pregunto por costos antes"
    ],
    "retrieved_context": "Horarios: lunes a viernes de 9 a 18 hrs."
  },
  "target_payload": {
    "response_text": "Nuestros horarios son de lunes a viernes de 9 a 18 hrs."
  },
  "metadata_payload": {
    "node": "rag",
    "reply_mode": "llm"
  }
}
```

### `appointment_reply`

```json
{
  "input_payload": {
    "user_message": "Quiero una cita manana a las 10",
    "contact_name": "Juan Perez",
    "summary": "Usuario desea agendar una cita.",
    "active_goal": "appointment",
    "stage": "collecting_slots",
    "pending_question": "Necesito el motivo o especialidad para continuar.",
    "last_assistant_message": "Claro, te ayudo con tu cita.",
    "recent_turns": [],
    "memories": [
      "Prefiere horario matutino"
    ],
    "appointment_state": {
      "patient_name": "Juan Perez",
      "reason": null,
      "preferred_date": "manana",
      "preferred_time": "10 am",
      "missing_fields": [
        "reason"
      ],
      "should_handoff": true,
      "confidence": 0.9
    },
    "booking_url": "https://calendly.com/gayagocr/new-meeting"
  },
  "target_payload": {
    "response_text": "Puedo ayudarte con eso. Comparteme el motivo de la cita y tambien puedes agendar aqui: https://calendly.com/gayagocr/new-meeting"
  },
  "metadata_payload": {
    "node": "appointment",
    "reply_mode": "fallback"
  }
}
```

Reglas:

- `rag_reply.input_payload.retrieved_context` guarda el contexto completo usado por producción, no previews truncados.
- No se usa `reply_context`, `clinic_context_preview` ni `rag_context_preview` como payload final de dataset.
- `appointment_reply` se proyecta desde la redacción final de la respuesta, no desde la extracción de slots.

## Script de preparación

El script [`scripts/prepare_trace_postgres.py`](/Users/gabrielgonzalez/Desktop/proyectos/eros/scripts/prepare_trace_postgres.py) prepara únicamente la infraestructura de tracing:

- pide `host`, `port`, `database`, `user`, `password`, `schema` y `sslmode` por terminal;
- construye el DSN en memoria;
- no persiste credenciales a disco;
- crea el schema dedicado y las tablas/índices de tracing de forma idempotente;
- imprime un resumen JSON final con el password oculto.

## Resumen de constraints

### Foreign keys declaradas

| Constraint | Tabla | Referencia |
| --- | --- | --- |
| `store_vectors_prefix_key_fkey` | `store_vectors` | `store(prefix, key)` |
| `trace_fragments_trace_id_fkey` | `tracing.trace_fragments` | `tracing.trace_turns(trace_id)` |
| `trace_examples_trace_id_fkey` | `tracing.trace_examples` | `tracing.trace_turns(trace_id)` |

### Constraints únicas

| Constraint | Tabla | Columnas |
| --- | --- | --- |
| `trace_turns_dedupe_key_key` | `tracing.trace_turns` | `dedupe_key` |

## Resumen de índices

| Tabla | Índice | Definición |
| --- | --- | --- |
| `store` | `store_prefix_idx` | `btree (prefix text_pattern_ops)` |
| `store` | `idx_store_expires_at` | `btree (expires_at) WHERE expires_at IS NOT NULL` |
| `store_vectors` | `store_vectors_embedding_idx` | `hnsw (embedding vector_cosine_ops)` |
| `checkpoints` | `checkpoints_thread_id_idx` | `btree (thread_id)` |
| `checkpoint_blobs` | `checkpoint_blobs_thread_id_idx` | `btree (thread_id)` |
| `checkpoint_writes` | `checkpoint_writes_thread_id_idx` | `btree (thread_id)` |
| `tracing.trace_turns` | `idx_trace_turns_session_key` | `btree (session_key)` |
| `tracing.trace_turns` | `idx_trace_turns_actor_key` | `btree (actor_key)` |
| `tracing.trace_turns` | `idx_trace_turns_flow_key` | `btree (flow_key)` |
| `tracing.trace_turns` | `idx_trace_turns_started_at` | `btree (started_at)` |
| `tracing.trace_turns` | `idx_trace_turns_outcome` | `btree (outcome)` |
| `tracing.trace_examples` | `idx_trace_examples_task_version_created_at` | `btree (task_name, projector_version, created_at DESC)` |
