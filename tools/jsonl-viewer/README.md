# JSONL Viewer

Visor y editor JSONL aislado del resto del proyecto. Esta pensado para revisar y editar datasets linea por linea desde el mismo workspace.

## Caracteristicas

- Lista automaticamente archivos `.jsonl` y `.ndjson` dentro del workspace.
- Abre archivos del repo por ruta relativa, por ejemplo `exports/dspy/conversation_reply.jsonl`.
- Permite cargar tambien un archivo local temporal desde el navegador.
- Detecta registros JSON completos aunque el archivo tenga objetos multilinea.
- Muestra cada registro como una unidad independiente con busqueda por texto.
- Edita el registro seleccionado como JSON formateado.
- Permite agregar, duplicar, eliminar y descargar registros.
- Guarda de vuelta al archivo original si estas en modo workspace.

## Uso

```bash
cd tools/jsonl-viewer
npm start
```

Despues abre `http://localhost:3210`.

## Notas

- El servidor solo permite leer y escribir archivos `.jsonl` o `.ndjson` dentro del workspace actual.
- Si una linea no es JSON valido, el guardado se bloquea hasta corregirla.
- Al guardar, los registros validos se normalizan a una salida JSONL estricta: un JSON por linea.
