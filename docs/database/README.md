# Referencia de Base de Datos

## Vista general

La aplicación usa un único esquema PostgreSQL, `public`, con tres grupos funcionales de tablas:

| Grupo | Propósito | Tablas principales |
| --- | --- | --- |
| Store de LangGraph | Memoria de largo plazo y soporte de búsqueda vectorial | `store`, `store_vectors`, `store_migrations`, `vector_migrations` |
| Checkpoints de LangGraph | Estado corto por hilo y escrituras pendientes del grafo | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations` |
| Trazas de la aplicación | Trazas por turno, fragmentos y ejemplos proyectados | `trace_turns`, `trace_fragments`, `trace_examples` |

La base actual también tiene habilitada la extensión `vector` de PostgreSQL.

## Distribución del esquema

Todas las tablas de la aplicación viven actualmente en el esquema `public`:

| Tabla |
| --- |
| `checkpoint_blobs` |
| `checkpoint_migrations` |
| `checkpoint_writes` |
| `checkpoints` |
| `store` |
| `store_migrations` |
| `store_vectors` |
| `trace_examples` |
| `trace_fragments` |
| `trace_turns` |
| `vector_migrations` |

## Responsabilidad por componente

| Componente | Tablas |
| --- | --- |
| `langgraph.store.postgres` | `store`, `store_vectors`, `store_migrations`, `vector_migrations` |
| `langgraph.checkpoint.postgres` | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations` |
| `app.tracing.repository.PostgresTraceRepository` | `trace_turns`, `trace_fragments`, `trace_examples` |

## Mapa de relaciones

| Padre | Hija | Relación |
| --- | --- | --- |
| `store` | `store_vectors` | Foreign key compuesta sobre (`prefix`, `key`) con `ON DELETE CASCADE` |
| `trace_turns` | `trace_fragments` | Foreign key sobre `trace_id` con `ON DELETE CASCADE` |
| `trace_turns` | `trace_examples` | Foreign key sobre `trace_id` con `ON DELETE CASCADE` |

Las tablas de checkpoints se relacionan de forma lógica por identificadores compartidos, no por foreign keys declaradas:

| Claves compartidas | Tablas |
| --- | --- |
| `thread_id`, `checkpoint_ns`, `checkpoint_id` | `checkpoints`, `checkpoint_writes` |
| `thread_id`, `checkpoint_ns`, pares de canal/versión | `checkpoints`, `checkpoint_blobs` |

## Convenciones de nombres

| Patrón | Significado |
| --- | --- |
| `prefix` | Namespace serializado usado por el store de LangGraph |
| `key` | Clave del ítem dentro de un namespace |
| `thread_id` | Identificador de hilo usado por checkpoints |
| `checkpoint_ns` | Namespace dentro de un hilo, por defecto cadena vacía |
| `trace_id` | Identificador único de una traza de turno |
| `*_payload` | Documento JSONB con datos estructurados de runtime |
| `*_migrations` | Tabla de versiones usada por los migradores |

## Notas de runtime

| Tema | Notas |
| --- | --- |
| Memoria de largo plazo | La aplicación guarda recuerdos bajo namespaces como `("memories", actor_id)`, que terminan serializados como `prefix` en `store` |
| Búsqueda vectorial | `store_vectors.embedding` usa el tipo `vector` y actualmente tiene un índice HNSW con distancia coseno |
| Estado corto | Los checkpoints de LangGraph persisten el estado del hilo en `checkpoints` y sus payloads binarios relacionados en `checkpoint_blobs` y `checkpoint_writes` |
| Deduplación de trazas | `trace_turns.dedupe_key` es único y se usa para evitar inserts duplicados del mismo turno lógico |

## Documentos de referencia

| Documento | Alcance |
| --- | --- |
| [`schema-reference.md`](./schema-reference.md) | Columnas, claves, índices y notas por tabla |
| [`query-reference.md`](./query-reference.md) | Consultas de inspección para debugging y mantenimiento |
