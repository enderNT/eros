# Arquitectura de estado corto y memoria duradera

Este documento reemplaza el plan anterior de `semantic-router`. La implementación actual usa `LangGraph` para estado corto por `conversation_id`, un runtime de memoria duradera reusable respaldado por stores de LangGraph y un router de estado con guards deterministas más clasificador LLM.

## Objetivo

Separar responsabilidades para que el asistente funcione con tres capas distintas:

- estado vivo del hilo en `LangGraph`
- memoria duradera en un store reusable de `LangGraph`
- recuperación documental en `Qdrant`

## Flujo actual

- `conversation_id` es el identificador del hilo.
- `contact_id` sigue siendo la clave lógica del usuario en memoria duradera.
- el router decide `conversation`, `rag` o `appointment` usando estado compacto.
- los nodos actualizan `active_goal`, `stage`, `pending_question`, `appointment_slots`, `last_tool_result` y el resumen corto del hilo.
- la memoria solo guarda hechos útiles, no el historial bruto.

## Limpieza

- `last_tool_result` se limpia cuando ya no aplica.
- `pending_action` y `pending_question` se limpian al salir de un subflujo.
- `appointment_slots` se vacía cuando la conversación deja de depender de cita.
- el resumen se refresca cuando cambia el objetivo o el hilo crece demasiado.

## Resultado esperado

- preguntas informativas van a `rag`
- saludos y conversación ligera quedan en `conversation`
- deseos de agendar y respuestas cortas de seguimiento permanecen en `appointment`
- la memoria duradera guarda solo recuerdos duraderos y útiles
