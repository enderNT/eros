# Eros Assistant Migration

Esta carpeta es la migracion de la app actual de Clinica Eros hacia la arquitectura del template TypeScript/Bun/Elysia.

Se conserva:

- payloads de dominio para routing, replies y LangGraph
- estado de negocio `GraphState`
- firmas DSPy del dominio
- separacion de flujo entre `conversation`, `rag` y `appointment`

Se cambia:

- stack principal a `TS/Bun/Elysia`
- implementacion de grafo a `LangGraph JS/TS`
- servicio DSPy a bridge Python de dominio
- el tracing persistente en Postgres vive en la app `TS/Bun`, no en el servicio Python

# Stateful Assistant Template

Boilerplate genérico para un asistente conversacional stateful en `Bun.js` con:

- API HTTP en `Elysia`
- orquestador de turno genérico
- capacidades `conversation`, `knowledge` y `action`
- estado corto por sesión
- memoria larga desacoplada detrás de interfaz
- provider LLM local o remoto compatible con OpenAI
- provider de memoria larga `Mem0` opcional
- backend de estado corto `in_memory` o `postgres`
- bridge opcional hacia un servicio Python estilo `DSPy`
- integración interna con `LangGraph` en `JS/TS` para rutas `conversation` y `rag`
- logging operacional dual (`terminal` resumida + `archivo` detallado con rotación)
- Docker y `docker-compose` para desarrollo local

## Objetivo

Este proyecto sirve como base reusable para construir asistentes conversacionales multicanal sin acoplar el core a un dominio, un canal o un proveedor concreto. La idea es que la lógica transversal ya exista aquí y que cualquier especialización futura viva en adapters, providers o módulos externos.

## Estructura

- `src/`: core, adapters y servidor HTTP.
- `dspy_service/`: servicio Python opcional para predicciones/fallbacks optimizados.
- `tests/`: pruebas mínimas del contrato interno.
- `docs/`: documentación de arquitectura, desarrollo y extensión.

## Arquitectura

El flujo principal del turno es:

`ingest -> load_context -> route -> execute capability -> finalize -> persist -> emit`

Piezas principales:

- `adapters/http`: normalizan payloads externos al contrato `InboundMessage`.
- `core/orchestrator`: coordina el turno completo.
- `core/capabilities`: ejecuta `conversation`, `knowledge` o `action`.
- `core/services`: implementaciones base en memoria, bridge HTTP a DSPy, `LangGraph` y utilidades.
- `dspy_service/`: servicio Python opcional reservado para `DSPy`.
- `domain/contracts` y `domain/ports`: contratos internos e interfaces desacopladas.

Documentación ampliada:

- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/development.md`](./docs/development.md)
- [`docs/langgraph.md`](./docs/langgraph.md)
- [`docs/logging.md`](./docs/logging.md)

## Endpoints

- `GET /health/live`: liveness básica del proceso.
- `GET /health/ready`: readiness del servicio para recibir tráfico.
- `GET /health/deps`: estado de dependencias observables como tracing y DSPy.
- `GET /health`: alias compatible de readiness.
- `POST /webhooks/messages`: recibe eventos y responde `202 Accepted`; el turno se procesa de forma asíncrona.
- `POST /webhooks/chatwoot`: endpoint equivalente al webhook de la app Python original.
- `POST /turns/execute`: ejecuta el turno de forma síncrona; útil para pruebas locales e integración.
- `GET /debug/traces`: expone el snapshot reciente del sink de trazas activo.

Con `Chatwoot`, el webhook principal ya puede:

- aceptar mensajes entrantes reales
- ignorar salientes/privados para evitar loops
- responder por la API oficial de conversaciones si `CHANNEL_PROVIDER=chatwoot`

## Ejemplo de payload

```json
{
  "sessionId": "session-123",
  "actorId": "user-42",
  "channel": "generic_http",
  "text": "Hola, necesito ayuda con el template"
}
```

## Configuración

La configuración está centralizada en [`.env.example`](./.env.example) y separada por namespaces:

- `APP_*`, `BUN_*`
- `APP_LOG_*`
- `LLM_*`
- `MEMORY_*`
- `STATE_*`
- `KNOWLEDGE_*`
- `TRACE_*`
- `DSPY_*`
- `CHANNEL_*`
- `CHATWOOT_*`
- `DOCKER_*`

Regla de diseño:

- Sí van en variables de entorno: URLs, llaves, toggles, budgets, thresholds y selección de proveedor.
- No deben ir ahí: prompts de dominio, catálogos funcionales, copy del bot o definición de acciones de negocio.

## Desarrollo

```bash
docker compose up --build
```

Los logs operativos se publican en dos destinos:

- terminal con una vista resumida por ejecución
- archivo persistente en `APP_LOG_DIR/APP_LOG_FILE`

Con `docker compose`, el destino de archivo queda montado en `/var/log/stateful-assistant`.

La implementacion migrada para Eros cubre:

- `conversation`
- `rag`
- `appointment`

Si tienes `bun` instalado localmente:

```bash
bun install
bun test
bun x tsc --noEmit
bun run src/index.ts
```

Para levantar solo el servicio Python de `DSPy` en local:

```bash
make dspy
```

Para levantar app + `DSPy` juntos en local:

```bash
bun run dev:with-dspy
```

Para publicar tu app local con `ngrok`:

```bash
bun run ngrok
```

## Extensión

Para convertir este template en un producto concreto, normalmente basta con reemplazar o agregar estas piezas:

- `MemoryProvider`: para persistencia y búsqueda real de memoria larga.
- `KnowledgeProvider`: para retrieval real.
- `OutboundTransport`: para emitir respuestas por un canal externo.
- `LlmProvider`: para usar un proveedor LLM real.
- `DspyBridge`: para activar predicción por el servicio Python si aplica.

## Estado actual del template

Incluye implementaciones base seguras para desarrollo:

- estado corto en memoria
- estado corto opcional en Postgres usando la misma conexión de tracing
- memoria larga en memoria
- memoria larga remota opcional con `Mem0`
- knowledge provider nulo
- transporte de salida no-op
- tracing en memoria o persistente en Postgres
- logging operacional con sanitización y correlación por ejecución
- rotación de logs tipo ring buffer por archivo/líneas
- bridge HTTP a DSPy con timeout, retry conservador y apertura temporal de circuito
- subgrafo LangGraph en TypeScript para `conversation` y `rag`
- preservación de payloads/estados del subgrafo para no acoplar el template a un negocio concreto

En modo `postgres`, el tracing se guarda después de responder al usuario y cada flush usa una conexión corta por ejecución.
