Quiero que tomes como referencia el upgrade ya aplicado a `conversation_reply` y `state_router`, y uses esos mismos principios para rediseñar otra tarea DSPy de la app.

No quiero que copies campos al azar ni que te limites a “quitar JSON”. Quiero que abstraigas el patrón de mejora que se aplicó y lo traduzcas de forma coherente a la nueva tarea.

Marco de diseño que debes seguir

1. Separar estado interno del sistema vs contexto que ve el LLM
- El sistema puede seguir usando estado estructurado, JSON, checkpoints, trazas y objetos ricos.
- El LLM no tiene por qué recibir ese estado crudo.
- Antes de llamar a DSPy/LLM, el estado interno debe transformarse en un input más compacto, legible y semánticamente útil.

2. Reducir ruido estructural y campos solapados
- Si varios campos dicen casi lo mismo, deben fusionarse.
- Si hay listas, objetos o estructuras que solo aportan redundancia, deben compactarse.
- No se trata solo de ahorrar tokens, sino de evitar contexto fragmentado, repetido o difícil de interpretar.

3. Mantener texto semiestructurado, no JSON crudo, cuando la tarea sea más semántica que mecánica
- Para tareas que dependen de comprensión contextual, continuidad o intención, el input ideal no es un objeto con muchas claves sueltas, sino texto claro con formato simple.
- Ese texto puede tener secciones internas estables, pero debe seguir siendo legible para el modelo.

4. Usar una sola fuente principal de contexto
- En vez de pasar muchos campos compitiendo entre sí, debe existir un contexto principal ya “cocinado”.
- Ese contexto principal puede ser narrativo, operativo o híbrido según la tarea.
- El objetivo es que el modelo reciba una visión unificada del caso.

5. Conservar solo apoyos complementarios de alto valor
- Además del contexto principal, solo deben quedar campos que realmente aporten una señal distinta.
- Ejemplo del patrón aplicado:
  - en `conversation_reply`: `last_assistant_message` quedó como apoyo de continuidad inmediata
  - en `state_router`: `user_message` quedó separado del `routing_context` para conservar el foco del turno actual

6. Hacer que el input “enseñe a pensar” sin sobrecargar
- La estructura del input debe inducir el tipo de razonamiento correcto.
- A veces eso se logra con una narración comprimida del hilo.
- A veces con un esquema textual operativo.
- No siempre hace falta chain-of-thought explícito.
- El diseño debe ayudar al modelo a leer el caso como queremos que lo interprete.

Patrón abstraído desde `conversation_reply`

Qué cambió conceptualmente
- Se dejó de mandar historial crudo, `recent_turns`, memorias solapadas y varios campos dispersos al modelo.
- Se creó un contexto más curado y digerible para responder.
- Se mantuvo el estado real del sistema en backend, pero no se expuso completo al prompt.
- Se privilegió continuidad conversacional, tono correcto y seguimiento natural del hilo.

Cómo quedó el input a nivel de diseño
- `user_message`: mantiene el mensaje actual del usuario como foco principal.
- `context_summary`: reemplaza el historial crudo por una narración comprimida del hilo.
- `last_assistant_message`: conserva continuidad inmediata sin meter toda la conversación.
- opcionalmente, un campo de razonamiento breve como `reply_reasoning` si la tarea necesita supervisar o enseñar mejor la forma de responder.

Qué debe aprender el nuevo diseño
- distinguir si la conversación ya está abierta o no
- saber qué ya se dijo
- saber qué quedó pendiente
- evitar repetir, contradecir o reiniciar el hilo
- responder con continuidad, no solo con información aislada

Naturaleza del `context_summary`
- No es un JSON
- No es una lista de turns crudos
- No es un resumen decorativo
- Es una narración breve del hilo, escrita para ayudar a generar la siguiente respuesta

Naturaleza del `reply_reasoning` si aplica
- No debe ser chain-of-thought largo
- Debe ser breve, estable y operativo
- Sirve para enseñar cómo conectar contexto y respuesta final

Patrón abstraído desde `state_router`

Qué cambió conceptualmente
- Se dejó de enviar múltiples campos sueltos de estado operativo al modelo.
- Se transformó ese estado en un “brief de ruteo” más compacto.
- El modelo ya no ve tantos campos fragmentados; ve una lectura unificada del caso.
- La salida sigue siendo fuertemente estructurada porque la tarea es de decisión, no de redacción.

Cómo quedó el input a nivel de diseño
- `user_message`: mantiene el turno actual como señal principal.
- `routing_context`: absorbe múltiples campos viejos en un texto operativo compacto.

Naturaleza del `routing_context`
- Es texto semiestructurado, no JSON crudo.
- Tiene secciones internas estables para ayudar a clasificar la ruta.
- Su propósito no es sonar natural, sino facilitar decisión.

Ejemplo de secciones internas válidas
- `Modo actual:`
- `Resumen del hilo:`
- `Ultimo mensaje del asistente:`
- `Ultimo resultado de herramienta:`
- `Memorias relevantes:` solo si de verdad aportan
- `Riesgo de factualidad:` como señal auxiliar, no como decisión final

Qué debe aprender el nuevo diseño
- distinguir conversación casual vs consulta factual vs intención operativa
- separar pedir información de avanzar una acción
- entender continuidad del hilo sin depender de JSON fragmentado
- decidir una ruta válida usando señales compactas y consistentes

Diseño de output según tipo de tarea

1. Si la tarea redacta lenguaje natural
- el input debe naturalizarse más
- el output puede seguir siendo texto simple o una estructura mínima

2. Si la tarea clasifica, enruta o actualiza estado operativo
- el input puede compactarse semánticamente
- el output debe seguir fuertemente estructurado y validable

Principio clave
- naturalizar el input no significa relajar el output
- puedes tener input más humano y output más estricto al mismo tiempo

Relación con métricas y entrenamiento

- El rediseño no es solo de prompt; también implica alinear dataset, firma y métricas.
- La firma nueva debe reflejar solo los campos realmente útiles.
- El dataset debe enseñar esa nueva forma de presentar el contexto.
- Las métricas deben premiar el comportamiento correcto según la nueva tarea:
  - continuidad conversacional en tareas de reply
  - ruteo correcto y decisión operativa en tareas de clasificación

Instrucción final para aplicar este patrón a otra tarea

Quiero que analices la tarea objetivo y propongas su rediseño siguiendo estas preguntas:

1. Qué parte del estado actual es ruido para el LLM
2. Qué campos están duplicando o fragmentando contexto
3. Cuál debería ser la única fuente principal de contexto
4. Qué apoyos mínimos complementarios sí conviene conservar
5. Si la tarea requiere un contexto narrativo, operativo o híbrido
6. Si el output debe simplificarse o seguir rígidamente estructurado
7. Qué cambios implicaría en firma, dataset, métricas, trazas y compatibilidad

No analices otras tareas todavía. Solo usa esta abstracción como patrón de rediseño.
