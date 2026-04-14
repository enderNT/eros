# `eros_neuronal`: estado actual de esquemas de memoria y tracing

Este documento describe el estado vigente de la base de datos PostgreSQL `eros_neuronal` después de la limpieza inicial para el rediseño.

El objetivo de esa limpieza fue:

- conservar únicamente el estado conversacional operativo
- conservar un único modelo de tracing
- eliminar el almacenamiento local de memoria de largo plazo, ya reemplazado por `mem0`

## Resumen ejecutivo

- Esquemas no-sistema vigentes: `public`, `tracing`
- El estado conversacional operativo sigue en `public.checkpoints*`
- El tracing vigente quedó consolidado en `tracing.*`
- La memoria de largo plazo local fue eliminada de la base
- También se eliminaron tablas duplicadas o sin uso que estaban en `public`

## Tablas vigentes

### `public`

Tablas detectadas:

- `checkpoint_blobs`
- `checkpoint_migrations`
- `checkpoint_writes`
- `checkpoints`

### `tracing`

Tablas detectadas:

- `trace_examples`
- `trace_fragments`
- `trace_turns`

## Conteos observados antes de la limpieza

Estos conteos se conservan como referencia histórica del estado previo:

### Estado conversacional

- `public.checkpoints`: `126`
- `public.checkpoint_blobs`: `251`
- `public.checkpoint_writes`: `1241`

### Tracing consolidado

- `tracing.trace_turns`: `28`
- `tracing.trace_fragments`: `183`
- `tracing.trace_examples`: `18`

### Objetos eliminados

- `public.trace_turns`: `10`
- `public.trace_fragments`: `49`
- `public.trace_examples`: `7`
- `public.turn_traces`: `0`
- `public.discovery_call_flows`: `0`
- `public.store`: `6`
- `public.store_vectors`: `6`

## Esquema `public`

El esquema `public` quedó reservado para el estado conversacional y de ejecución.

### `public.checkpoints`

Estado conversacional/checkpointing de ejecución.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `thread_id` | `text` | No |  | PK compuesta |
| `checkpoint_ns` | `text` | No | `''` | PK compuesta |
| `checkpoint_id` | `text` | No |  | PK compuesta |
| `parent_checkpoint_id` | `text` | Sí |  |  |
| `type` | `text` | Sí |  |  |
| `checkpoint` | `jsonb` | No |  | Payload principal |
| `metadata` | `jsonb` | No | `{}` | Metadata del checkpoint |

Payloads detectados:

- `checkpoint`: `channel_values`, `channel_versions`, `id`, `pending_sends`, `ts`, `updated_channels`, `v`, `versions_seen`
- `metadata`: `parents`, `source`, `step`

### `public.checkpoint_blobs`

Blobs asociados a canales/versiones de checkpoint.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `thread_id` | `text` | No |  | PK compuesta |
| `checkpoint_ns` | `text` | No | `''` | PK compuesta |
| `channel` | `text` | No |  | PK compuesta |
| `version` | `text` | No |  | PK compuesta |
| `type` | `text` | No |  |  |
| `blob` | `bytea` | Sí |  |  |

### `public.checkpoint_writes`

Escrituras unitarias asociadas a tareas dentro de un checkpoint.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `thread_id` | `text` | No |  | PK compuesta |
| `checkpoint_ns` | `text` | No | `''` | PK compuesta |
| `checkpoint_id` | `text` | No |  | PK compuesta |
| `task_id` | `text` | No |  | PK compuesta |
| `idx` | `integer` | No |  | PK compuesta |
| `channel` | `text` | No |  |  |
| `type` | `text` | Sí |  |  |
| `blob` | `bytea` | No |  |  |
| `task_path` | `text` | No | `''` |  |

### `public.checkpoint_migrations`

Control de versión de migraciones para el subsistema de checkpoints.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `v` | `integer` | No |  | PK |

## Esquema `tracing`

El esquema `tracing` quedó como fuente única de verdad para trazas.

### `tracing.trace_turns`

Trazas por turno.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `trace_id` | `text` | No |  | PK |
| `parent_trace_id` | `text` | Sí |  |  |
| `session_key` | `text` | No |  |  |
| `actor_key` | `text` | No |  |  |
| `app_key` | `text` | No |  |  |
| `flow_key` | `text` | No |  |  |
| `dedupe_key` | `text` | Sí |  | UNIQUE |
| `started_at` | `timestamptz` | No |  |  |
| `completed_at` | `timestamptz` | Sí |  |  |
| `component_version` | `text` | Sí |  |  |
| `model_backend` | `text` | Sí |  |  |
| `model_name` | `text` | Sí |  |  |
| `outcome` | `text` | No |  |  |
| `has_error` | `boolean` | No | `false` |  |
| `projector_eligibility_summary` | `jsonb` | No | `{}` |  |
| `input_payload` | `jsonb` | No | `{}` | Entrada del turno |
| `output_payload` | `jsonb` | No | `{}` | Salida del turno |
| `error_payload` | `jsonb` | No | `{}` | Errores |
| `metrics_payload` | `jsonb` | No | `{}` | Métricas |
| `tags` | `jsonb` | No | `{}` | Etiquetas |
| `extra_payload` | `jsonb` | No | `{}` | Extensión libre |

Payloads detectados:

- `input_payload`: `account_id`, `channel`, `contact_id`, `contact_name`, `conversation_id`, `event`, `message`, `message_type`
- `output_payload`: `active_goal`, `actor_id`, `appointment_payload`, `appointment_slots`, `confidence`, `contact_name`, `handoff_required`, `intent`, `last_assistant_message`, `last_tool_result`, `last_user_message`, `needs_retrieval`, `next_node`, `pending_action`, `pending_question`, `recalled_memories`, `recent_turns`, `response_preview`, `response_text`, `routing_reason`, `session_id`, `stage`, `state_update`, `summary`, `summary_refresh_requested`, `turn_count`
- `error_payload`: `message`, `type`
- `metrics_payload`: `branch`, `response_chars`
- `tags`: `branch`, `intent`

### `tracing.trace_fragments`

Fragmentos o etapas internas asociadas a una traza.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `trace_id` | `text` | No |  | PK compuesta, FK a `trace_turns` |
| `order` | `integer` | No |  | PK compuesta |
| `kind` | `text` | No |  |  |
| `label` | `text` | No | `''` |  |
| `created_at` | `timestamptz` | No |  |  |
| `latency_ms` | `integer` | Sí |  |  |
| `token_usage` | `jsonb` | No | `{}` |  |
| `payload` | `jsonb` | No | `{}` | Payload del fragmento |

Payload detectado en `payload`:

- `active_goal`, `assistant_message`, `confidence`, `conversation_id`, `current_summary`, `guard_hint`, `handoff_required`, `intent`, `last_assistant_message`, `memories`, `needs_retrieval`, `next_node`, `pending_question`, `reason`, `recalled_memories`, `recent_turns`, `reply_mode`, `response_text`, `routing_packet`, `stage`, `state_update`, `status`, `stored_records`, `summary`, `summary_refreshed`, `summary_refresh_requested`, `turn_count`, `updated_summary`, `user_message`

### `tracing.trace_examples`

Ejemplos derivados de trazas para entrenamiento/proyección/evaluación.

| Columna | Tipo | Nulo | Default | Notas |
| --- | --- | --- | --- | --- |
| `trace_id` | `text` | No |  | PK compuesta, FK a `trace_turns` |
| `task_name` | `text` | No |  | PK compuesta |
| `projector_version` | `text` | No |  | PK compuesta |
| `created_at` | `timestamptz` | No |  |  |
| `split` | `text` | No | `'train'` |  |
| `quality_label` | `text` | Sí |  |  |
| `input_payload` | `jsonb` | No | `{}` |  |
| `target_payload` | `jsonb` | No | `{}` |  |
| `metadata_payload` | `jsonb` | No | `{}` |  |
| `eligibility_reason` | `text` | No | `''` |  |

Payloads detectados:

- `input_payload`: `contact_name`
- `target_payload`: `response_text`
- `metadata_payload`: `node`, `reply_mode`

## Objetos eliminados en esta fase

Se eliminaron explícitamente estos objetos por duplicidad, desuso o cambio de arquitectura:

- `public.trace_turns`
- `public.trace_fragments`
- `public.trace_examples`
- `public.turn_traces`
- `public.discovery_call_flows`
- `public.store`
- `public.store_vectors`
- `public.store_migrations`
- `public.vector_migrations`

## Lectura de arquitectura vigente

### Memoria

- La memoria de largo plazo ya no vive en esta base; debe resolverse desde `mem0`
- La base conserva solo el estado operativo/transaccional necesario para ejecución conversacional
- Ese estado operativo vive en `public.checkpoints`, `public.checkpoint_blobs` y `public.checkpoint_writes`

### Tracing

- El tracing vigente quedó centralizado en `tracing.*`
- Ya no hay duplicidad entre `public.trace_*` y `tracing.*`
- Ya no queda en la base el modelo alterno `public.turn_traces`

## Implicaciones para el siguiente rediseño

- Cualquier integración nueva de memoria persistente debe conectarse directamente con `mem0`
- Si algún flujo seguía leyendo de `public.store` o `public.store_vectors`, ese código deberá retirarse o migrarse
- El tracing nuevo debería escribir únicamente en `tracing.trace_turns`, `tracing.trace_fragments` y `tracing.trace_examples`
- `public.checkpoints*` debe tratarse como infraestructura de estado de ejecución, no como memoria semántica de largo plazo
