# DSPy Input Templates

Referencia corta de las plantillas visibles del input para `conversation_reply` y `state_router`.

## `conversation_reply`

```text
Contexto resumido del hilo:
El usuario primero preguntó por precios de estimulación. Ya se le compartieron costos, se aclaró que el número de sesiones depende de una valoración inicial y ahora su mensaje apunta a avanzar dentro del mismo hilo. La conversación ya está en curso, por lo que no hace falta volver a saludar. No se deben inventar horarios ni repetir toda la información previa.

Ultimo mensaje del asistente: Valoración psiquiátrica inicial: 800 MXN. Terapia de estimulación magnética transcraneal: 900 MXN por sesión. Si quieres, también puedo orientarte sobre el proceso para agendar.

Mensaje actual del usuario: quiero 20 sesiones
```

## `state_router`

```text
Mensaje actual del usuario: que horarios tienen mañana

Contexto de ruteo:
Modo actual: appointment.
Resumen del hilo: El usuario viene avanzando dentro de una conversación de agenda y ahora pregunta por disponibilidad concreta para asistir.
Ultimo mensaje del asistente: Se le indicó que podía compartir el enlace para revisar horarios o continuar con la gestión de la cita.
Ultimo resultado de herramienta: n/a
Memorias relevantes: sin memorias relevantes.
Riesgo de factualidad: alto: puede requerir retrieval o continuidad factual.

Guard hint: {}
```

## Idea base

- `conversation_reply` usa una plantilla narrativa para responder con continuidad.
- `state_router` usa una plantilla operativa para decidir una ruta.
- En ambos casos, el modelo recibe texto compacto y legible en lugar de estado crudo.
