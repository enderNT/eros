# Plan de optimización DSPy para `conversation_reply`

## Resumen
- Tomar como fuente canónica únicamente [conversation_reply.jsonl](/Users/gabrielgonzalez/Desktop/proyectos/eros/exports/dspy/conversation_reply.jsonl).
- Ejecutar una optimización offline solo para la tarea `conversation_reply`, generar su artefacto DSPy y dejarlo listo para ser consumido después por el runtime existente.
- No tocar router, `rag_reply`, `appointment_reply`, ni nada de infraestructura, despliegue o contenedores.
- Priorizar “artefacto + validación mínima”: compilar el artefacto y acompañarlo de una validación offline pequeña pero obligatoria antes de considerarlo listo.

## Cambios de implementación
- Corregir [scripts/optimize_dspy_task.py](/Users/gabrielgonzalez/Desktop/proyectos/eros/scripts/optimize_dspy_task.py) para que lea correctamente datasets JSONL con objetos multilinea, porque el flujo actual usa `splitlines()` y rompería el dataset real de `conversation_reply`.
- Mantener el contrato actual de optimización por tarea (`--task conversation_reply --dataset ... --artifact-out ...`), pero añadir una validación previa del dataset:
  - aceptar solo registros con `task_name == "conversation_reply"`;
  - exigir `input_payload` y `target_payload.response_text`;
  - rechazar registros vacíos o JSON inválido;
  - emitir un resumen claro de cuántos ejemplos válidos entran a compilación.
- Añadir una fase offline de validación específica para `conversation_reply`:
  - split determinístico del dataset canónico en train/eval;
  - con el dataset actual de 5 ejemplos: usar 4 para compilar y 1 como holdout;
  - si el dataset crece después: usar una regla fija de 80/20 con mínimo 1 ejemplo en eval.
- Compilar un artefacto candidato con el optimizador ya previsto (`dspy.LabeledFewShot`) usando solo train.
- Generar un reporte de evaluación offline con, por cada ejemplo de eval:
  - input serializado;
  - `target_payload.response_text`;
  - salida baseline sin artefacto;
  - salida del artefacto optimizado;
  - campos mínimos de comparación para revisión humana.
- Definir promoción del artefacto final así:
  - el artefacto candidato se usa para la evaluación offline;
  - si pasa la revisión mínima, se recompila usando el dataset canónico completo;
  - el artefacto final se guarda en la ruta runtime por defecto: `artifacts/dspy/conversation_reply.json`.
- Generar además un archivo de metadatos junto al artefacto final, por ejemplo `artifacts/dspy/conversation_reply.meta.json`, con:
  - task;
  - dataset fuente;
  - cantidad de ejemplos;
  - hash o fingerprint del dataset;
  - fecha/hora de compilación;
  - optimizador usado;
  - tamaño del train/eval split usado para validar.
- No cambiar [app/dspy/runtime.py](/Users/gabrielgonzalez/Desktop/proyectos/eros/app/dspy/runtime.py) salvo que haga falta una mejora menor de robustez; el runtime ya sabe cargar `conversation_reply` desde `artifacts/dspy/conversation_reply.json` y ya hace fallback si el artefacto no existe o falla.
- No añadir lógica nueva para otras tareas. Si se generaliza algo, debe ser solo la lectura robusta del dataset, sin alterar comportamiento funcional de `rag_reply` o `appointment_reply`.

## Interfaces y salidas esperadas
- Entrada canónica:
  - dataset: [conversation_reply.jsonl](/Users/gabrielgonzalez/Desktop/proyectos/eros/exports/dspy/conversation_reply.jsonl)
  - task: `conversation_reply`
- Salidas obligatorias:
  - artefacto final: `artifacts/dspy/conversation_reply.json`
  - reporte offline: `artifacts/dspy/conversation_reply.eval.json`
  - metadatos del build: `artifacts/dspy/conversation_reply.meta.json`
- Comando operativo esperado:
  - seguir usando [scripts/optimize_dspy_task.py](/Users/gabrielgonzalez/Desktop/proyectos/eros/scripts/optimize_dspy_task.py) como entrypoint principal;
  - si hace falta separar responsabilidades, añadir un script de evaluación offline, pero el flujo final debe seguir siendo de un solo task y con rutas fijas para `conversation_reply`.

## Plan de validación
- Añadir pruebas unitarias en [tests/test_dspy.py](/Users/gabrielgonzalez/Desktop/proyectos/eros/tests/test_dspy.py) para cubrir:
  - lectura correcta del dataset multilinea actual;
  - validación de ejemplos `conversation_reply`;
  - generación de artefacto para `conversation_reply`;
  - resolución de ruta por defecto a `artifacts/dspy/conversation_reply.json`;
  - fallback del runtime si el artefacto falta o falla.
- Verificaciones offline obligatorias al ejecutar el flujo:
  - el dataset canónico carga 100% sin partir registros;
  - el split train/eval es determinístico;
  - se produce el reporte de evaluación;
  - se genera el artefacto final en la ruta esperada;
  - el runtime puede cargar ese artefacto sin tocar otras tareas.
- Criterio de aceptación mínimo:
  - el artefacto final existe y carga;
  - el reporte offline compara baseline vs optimizado en el holdout;
  - la revisión humana del holdout no detecta degradación obvia frente al baseline o frente al target;
  - no se introducen regresiones en pruebas DSPy/runtime existentes.

## Suposiciones y decisiones fijadas
- Se usará como fuente oficial únicamente [conversation_reply.jsonl](/Users/gabrielgonzalez/Desktop/proyectos/eros/exports/dspy/conversation_reply.jsonl), no copias ni backups.
- La “optimización” para esta fase significa compilación DSPy con `LabeledFewShot`, no fine-tuning de modelo.
- La validación será offline y mínima, con revisión humana apoyada por reporte; no se diseñará todavía una métrica automática de calidad de producción.
- El artefacto final debe quedar listo para consumo por el runtime actual en `artifacts/dspy/conversation_reply.json`.
- No se modificará el alcance hacia despliegue, Docker, volúmenes o producción operativa.
