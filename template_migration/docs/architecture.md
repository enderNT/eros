# Arquitectura

## Propósito

El template está diseñado para resolver el problema transversal de un asistente stateful:

- recibir eventos desde cualquier canal
- mantener continuidad entre turnos
- decidir qué capacidad ejecutar
- recuperar memoria y conocimiento cuando haga falta
- generar una respuesta o avanzar un flujo
- persistir el estado y dejar trazabilidad completa

El objetivo es que el core siga siendo genérico. Todo lo que dependa de negocio, dominio o proveedor debe vivir fuera de estas piezas centrales.

## Flujo del turno

Secuencia principal:

1. `ingest`
2. `load_context`
3. `route`
4. `execute capability`
5. `finalize`
6. `persist`
7. `emit`

## Contratos internos

Los contratos viven en `src/domain/contracts.ts`.

- `InboundMessage`: mensaje normalizado de entrada.
- `RouteDecision`: decisión de routing.
- `CapabilityResult`: resultado de la capacidad ejecutada.
- `TurnOutcome`: salida consolidada del turno.
- `ShortTermState`: estado corto del hilo.
- `MemoryHit`: recuerdo recuperado desde memoria larga.

La intención es que cualquier adapter externo solo tenga que traducir hacia o desde estos contratos.

## Puertos e implementaciones

Las interfaces del sistema viven en `src/domain/ports.ts`.

- `MemoryProvider`
- `KnowledgeProvider`
- `LlmProvider`
- `DspyBridge`
- `TraceSink`
- `OutboundTransport`
- `StateStore`

Las implementaciones incluidas son deliberadamente simples:

- `InMemoryStateStore`
- `InMemoryMemoryProvider`
- `NoopKnowledgeProvider`
- `InMemoryTraceSink`
- `NoopTransport`
- `GenericLlmProvider`
- `HttpDspyBridge`

Esto permite desarrollar y probar la arquitectura sin bloquear el arranque por dependencias externas.

## Capas

### API Layer

La API vive en `src/app.ts` con `Elysia`.

- `POST /webhooks/messages` responde rápido con `202` y procesa en segundo plano.
- `POST /turns/execute` es útil para pruebas síncronas.
- `GET /health` y `GET /debug/traces` cubren operación y debugging.
- `POST /webhooks/messages` también discrimina eventos de Chatwoot para procesar solo mensajes entrantes.

### Inbound / Outbound Adapters

- `src/adapters/http/inbound.ts` transforma payloads externos a `InboundMessage`.
- `src/adapters/channels/noop-transport.ts` muestra el fallback cuando no hay canal real.
- `src/adapters/channels/chatwoot-transport.ts` envía respuestas al endpoint oficial de mensajes de Chatwoot.

### Chatwoot

La integración actual con Chatwoot cubre:

- recepción por webhook en el endpoint principal
- normalización de payload tipo `message_created`
- filtro de seguridad para ignorar mensajes `outgoing`, privados o no originados por contacto
- envío de respuestas por `POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages`

El filtro de entrada existe para evitar que los mensajes emitidos por la app regresen al webhook y ciclen el sistema.

### Core Orchestrator

`TurnOrchestrator` es el corazón del sistema.

Responsabilidades:

- cargar estado corto
- recuperar memoria larga
- construir `promptDigest`
- decidir routing
- invocar capability
- refrescar resumen del hilo
- persistir estado y memoria
- emitir y trazar

### Capacidades

Las capacidades viven en `src/core/capabilities`.

- `conversation`
- `knowledge`
- `action`

Cada una intenta usar primero el bridge DSPy si está activo y, si no, hace fallback al `LlmProvider`.

### Memoria

El template separa dos niveles:

- estado corto por `sessionId`
- memoria larga por `actorId + agentId`

Además conserva explícitamente:

- `rawRecall`: para trazas y evaluación
- `promptDigest`: para el presupuesto real del prompt

Cuando el recall excede el budget, se resume el conjunto seleccionado en lugar de truncar ciegamente cada elemento.

### Observabilidad

El sink de trazas registra:

- evento de entrada
- contexto cargado
- routing
- ejecución de capability
- outcome final
- error, si ocurre

También proyecta datasets simples en memoria para:

- `route_decision`
- `conversation_reply`
- `knowledge_reply`
- `action_reply`
- `state_summary`

Además, el template separa explícitamente:

- `logs operativos`: lectura humana, terminal resumida y archivo detallado
- `trazas`: datasets internos y snapshots de depuración

### Logging operacional

El logger operacional sigue dos destinos con objetivos distintos:

- `terminal`: cinco fases (`IN`, `ROUTE`, `FLOW`, `OUT`, `END`) con el mínimo útil por ejecución
- `archivo`: bloques estructurados (`INPUT`, `CONTEXT`, `ROUTE`, `TOOL`, `MODEL`, `FLOW`, `OUTPUT`, `END`)

Cada ejecución genera:

- `run_id`
- `correlation_id`
- `session_id`
- `started_at`
- `elapsed_ms`

El archivo se escribe en texto plano, en UTC e ISO 8601, y sanitiza claves sensibles antes de persistir contenido.

### DSPy Bridge

`dspy_service/` representa un servicio Python separado y opcional.

El bridge Bun:

- usa HTTP interno
- aplica timeout estricto
- hace retry conservador
- abre circuito temporalmente si el servicio falla
- cae al `LlmProvider` sin detener el sistema

### LangGraph

La implementación actual de `LangGraph` vive dentro de la aplicación `JS/TS`, en `src/core/services/langgraph-capability-graph.ts`.

El grafo actual tiene dos rutas:

- `conversation`
- `rag`

`rag` se traduce de vuelta al capability `knowledge` para conservar compatibilidad con el core actual del boilerplate.

En esta etapa:

- LangGraph organiza la ejecución para `conversation`
- LangGraph organiza la ejecución para `rag`
- la ruta `rag` resuelve retrieval desde `KnowledgeProvider`
- los nodos pueden seguir usando `DSPy` como motor opcional de reply
- `action` permanece fuera del grafo y conserva fallback controlado

## Principios de diseño

- El core no conoce detalles de dominio.
- Los providers reales deben entrar por interfaces.
- Los defaults del template deben permitir desarrollo local.
- La observabilidad debe existir desde el primer día.
- La continuidad conversacional debe vivir en el flujo, no solo en el último mensaje.
