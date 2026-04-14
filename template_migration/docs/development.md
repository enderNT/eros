# Desarrollo y Extensión

## Requisitos

- `Bun.js`
- `Docker` y `docker compose` para levantar el stack completo
- `Python` solo si quieres ejecutar o extender el servicio auxiliar localmente fuera de Docker

## Comandos útiles

Instalar dependencias:

```bash
bun install
```

Ejecutar pruebas:

```bash
bun test
```

Validar sintaxis del servicio Python:

```bash
python3 -m py_compile dspy_service/app.py
```

Validar tipos:

```bash
bun x tsc --noEmit
```

Levantar app principal:

```bash
bun run src/index.ts
```

Levantar app principal + runtime `DSPy`:

```bash
bun run dev:with-dspy
```

Levantar solo el servicio local de `DSPy`:

```bash
make dspy
```

Si `make dspy` falla por falta de entorno virtual:

```bash
python3 -m venv .venv
./.venv/bin/pip install -r dspy_service/requirements.txt
```

Exponer la app local con `ngrok`:

```bash
bun run ngrok
```

Levantar stack completo:

```bash
docker compose up --build
```

Ver logs operativos en terminal:

```bash
docker compose logs -f app
```

Ver el archivo persistido:

```bash
docker compose exec app sh -lc 'tail -n 200 /var/log/stateful-assistant/app.log'
```

Configurar Chatwoot en local:

```bash
CHANNEL_PROVIDER=chatwoot
CHANNEL_REPLY_ENABLED=true
CHATWOOT_BASE_URL=https://tu-chatwoot.example.com
CHATWOOT_API_ACCESS_TOKEN=tu_token
```

Configurar provider remoto OpenAI-compatible:

```bash
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://tu-backend-openai-compatible/v1
LLM_API_KEY=tu_token
LLM_MODEL=gpt-4o-mini
```

Configurar memoria larga remota con Mem0:

```bash
MEMORY_PROVIDER=mem0
MEM0_BASE_URL=https://tu-backend-mem0
MEM0_API_KEY=tu_token
MEM0_AUTH_MODE=auto
```

## Formas de uso

### 1. Webhook asíncrono

`POST /webhooks/messages`

Pensado para canales externos que necesitan acuse temprano.

Con Chatwoot, este endpoint filtra automáticamente mensajes salientes o privados para evitar loops.

Ejemplo:

```bash
curl -X POST http://localhost:3000/webhooks/messages \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "session-1",
    "actorId": "user-1",
    "channel": "generic_http",
    "text": "Hola, quiero probar el template"
  }'
```

### 2. Ejecución síncrona

`POST /turns/execute`

Útil para pruebas manuales, integración local y testeo de adapters.

Para probar el subgrafo LangGraph en la app, envía un turno que el routing resuelva como:

- `conversation`
- `knowledge`

Si además quieres que los nodos del grafo intenten usar `DSPy` antes del fallback local, activa:

- `DSPY_ENABLED=true`
- `DSPY_CONVERSATION_REPLY_ENABLED=true`
- `DSPY_KNOWLEDGE_REPLY_ENABLED=true`

## Qué reemplazar en un proyecto real

### MemoryProvider

Sustituye `InMemoryMemoryProvider` por una implementación real si necesitas:

- persistencia entre reinicios
- búsqueda semántica
- políticas de escritura configurables
- metadata operativa enriquecida

### KnowledgeProvider

Sustituye `NoopKnowledgeProvider` por un provider de retrieval si el producto requiere:

- búsqueda documental
- RAG
- catálogos o bases de conocimiento

### LlmProvider

`GenericLlmProvider` es solo una base funcional.

En un producto real normalmente se reemplaza por una implementación que:

- llame a un proveedor LLM
- use prompts versionados
- maneje budgets y tool calling
- incorpore identidad, tono e instrucciones configurables

### OutboundTransport

`NoopTransport` no envía nada fuera del proceso. Un adapter real debería:

- transformar `TurnOutcome` al formato del canal
- manejar errores y reintentos
- dejar trazas suficientes

### DSPy Bridge

El bridge ya existe, pero está apagado por defecto. Si lo activas:

- el servicio Python debe responder los endpoints esperados
- el servicio Python sigue siendo exclusivo para `DSPy`
- conviene monitorear latencia y fallback
- el sistema debe seguir funcionando si el servicio cae
- el runtime puede cargar artefactos persistidos y datasets semilla desde `DSPY_ARTIFACTS_DIR` y `DSPY_DATASETS_DIR`

## Convenciones de extensión

- Mantén el dominio fuera del core.
- Prefiere agregar adapters o providers antes que modificar contratos internos.
- Si agregas una nueva capacidad, primero define su contrato y luego su integración en el orquestador.
- Si agregas un canal, su trabajo principal debe ser normalizar entrada y traducir salida.

## Validación mínima recomendada

Antes de extender o integrar este template:

1. Ejecuta `bun test`.
2. Ejecuta `bun x tsc --noEmit`.
3. Verifica `GET /health`.
4. Prueba `POST /turns/execute`.
5. Revisa `GET /debug/traces` para confirmar la secuencia del turno.
6. Confirma que la terminal no muestre dumps internos innecesarios.
7. Confirma que el archivo incluya `run_id`, `correlation_id` y bloques detallados.
8. Confirma que no aparezcan secretos o credenciales en claro.
