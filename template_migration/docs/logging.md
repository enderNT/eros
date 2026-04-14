# Logging Operacional

## Objetivo

El proyecto separa dos conceptos:

- `logs operativos`: lectura y diagnóstico de ejecuciones reales
- `trazas`: datasets internos y snapshots de depuración

Los cambios de esta implementación afectan únicamente al logging operativo.

## Destinos

### Terminal

La terminal muestra una vista corta por ejecución:

- `IN`
- `ROUTE`
- `FLOW`
- `OUT`
- `END`

Cada ejecución abre y cierra con separadores coloreados. El rojo queda reservado para errores capturados.

### Archivo

El archivo es la fuente de reconstrucción completa y usa bloques como:

- `[01.INPUT]`
- `[02.CONTEXT]`
- `[03.ROUTE]`
- `[04.TOOL.<name>]`
- `[05.MODEL.<name>]`
- `[06.FLOW]`
- `[07.OUTPUT]`
- `[08.END]`

El formato es texto plano, sin ANSI, con timestamps UTC en ISO 8601.

## Correlación

Cada ejecución registra:

- `run_id`
- `correlation_id`
- `session_id`
- `parent_run_id` cuando existe
- `started_at`
- `elapsed_ms`

Si no llega un `correlation_id` externo, se reutiliza `session_id` como correlador mínimo.

## Seguridad

Antes de persistir datos, el logger:

- redacta claves sensibles como `token`, `secret`, `authorization`, `cookie`, `password` y similares
- trunca strings largos
- limita profundidad de objetos y arrays

El objetivo es conservar request/response útiles sin convertir el archivo en un volcado bruto del proceso.

## Variables de entorno

Las variables nuevas son:

- `APP_LOG_TO_CONSOLE`
- `APP_LOG_TO_FILE`
- `APP_LOG_DIR`
- `APP_LOG_FILE`
- `APP_INSTANCE_ID`
- `APP_CONTAINER_NAME`
- `APP_CONTAINER_ID`
- `APP_HOST_NAME`

## Docker

En `docker-compose.yml` el servicio principal monta un volumen persistente en:

`/var/log/stateful-assistant`

Eso permite que el archivo oficial de logs sobreviva reinicios o recreaciones del contenedor.

## Cobertura actual

La implementación registra:

- entrada normalizada
- contexto resumido y memoria recuperada
- decisión de routing
- llamadas al bridge DSPy cuando aplican
- llamadas al provider generativo del template
- retrieval de conocimiento cuando aplica
- salida final y estado de emisión
- cierre exitoso o error capturado

No sustituye al `TraceSink` ni al endpoint `GET /debug/traces`; ambos mecanismos conviven con responsabilidades distintas.
