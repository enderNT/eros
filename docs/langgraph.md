# LangGraph en el Boilerplate

## Alcance actual

La integración actual de `LangGraph` vive dentro de la aplicación `JS/TS` y está pensada como una primera capa de orquestación local conectada al core del boilerplate.

Por ahora el grafo solo cubre dos rutas:

- `conversation`
- `rag`

## Mapeo con el core

El core del boilerplate sigue manejando estos capabilities:

- `conversation`
- `knowledge`
- `action`

Para no romper contratos existentes:

- la ruta `conversation` de LangGraph se devuelve como capability `conversation`
- la ruta `rag` de LangGraph se devuelve como capability `knowledge`
- los payloads/estados que consumen las tareas del subgrafo deben preservarse en la medida de lo posible; los cambios nuevos deben inyectarse alrededor del contexto sin redefinir esos estados para un negocio concreto

## Flujo

1. Bun normaliza el inbound.
2. El orquestador decide la capability principal.
3. Si la capability es `conversation` o `knowledge`, entra al subgrafo de `LangGraph`.
4. El nodo correspondiente produce la respuesta.
5. Bun conserva la responsabilidad de persistencia, memoria, logging y emisión.

## Rutas implementadas

### conversation

Se usa para continuidad conversacional y puede aprovechar `promptDigest` como memoria resumida.

### rag

Se usa para consultas que requieren contexto recuperado. Consume la lista `knowledge` que ya arma el core del boilerplate.

## Integración con DSPy

`DSPy` sigue viviendo exclusivamente en Python.

Los nodos del grafo pueden:

- intentar `DSPy` primero si está habilitado
- hacer fallback al provider TS del template si `DSPy` no responde o está deshabilitado

## Restricción de compatibilidad

Esta portación evita fijar estados, stages o payloads de negocio dentro del grafo.

Se permite:

- inyectar datos nuevos en el contexto envolvente
- cambiar wiring interno del runtime
- refactorizar nombres internos de nodos/canales para resolver colisiones técnicas

No se debe:

- rediseñar la forma de los estados/payloads que ya consumen las tareas del subgrafo
- mover la responsabilidad del grafo al servicio Python

## Lo que todavía no cubre

Esta primera iteración no mueve todo el sistema a LangGraph. Aún quedan fuera:

- `action`
- tools reales dentro del grafo
- persistencia de estado del grafo
- nodos de recuperación reales
- routing completo de toda la aplicación dentro del grafo

## Archivos clave

- `src/core/services/langgraph-capability-graph.ts`
- `src/core/orchestrator.ts`
- `src/core/services/http-dspy-bridge.ts`
