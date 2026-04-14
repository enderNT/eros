import os
import json
from pathlib import Path
from datetime import datetime
import dspy
from dspy.teleprompt import BootstrapFewShot

# Importar configuración y módulo directo del servicio
from app import RuntimeSettings
from modules import RagReplyModule

def load_env_file():
    """Carga variables desde el archivo .env de la raíz del proyecto."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    # No sobreescribir si ya existe en el entorno
                    if key.strip() not in os.environ:
                        os.environ[key.strip()] = val.strip().strip("'\"")

def dummy_metric(example, pred, trace=None):
    """Métrica básica para validar el RAG generado."""
    return len(pred.response_text) > 10

def main():
    # 0. Cargar archivo .env para simular el entorno automático
    load_env_file()
    
    # 1. Cargar las mismas configuraciones de tu aplicación
    settings = RuntimeSettings.from_env()
    
    if not settings.api_key:
        print("Error: No se encontró DSPY_API_KEY ni OPENAI_API_KEY en el entorno ni en tu archivo .env.")
        return
        
    print(f"[*] Usando modelo configurado: {settings.model}")
    qualified_model = settings.model if "/" in settings.model else f"openai/{settings.model}"
    
    lm = dspy.LM(
        model=qualified_model, 
        api_key=settings.api_key, 
        api_base=settings.api_base or None
    )
    dspy.configure(lm=lm)
    
    # 2. Archivos usando paths de app.py
    # Si la ruta en .env incluye 'dspy_service/' pero ya estamos dentro de ella, la ajustamos.
    dataset_path = settings.datasets_dir / "rag_reply.jsonl"
    if not dataset_path.exists() and "dspy_service" in str(settings.datasets_dir):
        # Intentar fallback local si la ruta de .env asume ejecución desde la raíz
        fallback_path = Path(__file__).resolve().parent / "datasets" / "rag_reply.jsonl"
        if fallback_path.exists():
            dataset_path = fallback_path
            print(f"[*] Ajustando ruta de dataset a: {dataset_path}")

    if not dataset_path.exists():
        print(f"Error: No se encontró el dataset en {dataset_path}")
        return
        
    trainset = []
    with open(dataset_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            data = json.loads(line)
            
            example = dspy.Example(
                user_message=str(data.get("user_message", "")),
                summary=str(data.get("summary", "")),
                active_goal=str(data.get("active_goal", "")),
                stage=str(data.get("stage", "")),
                pending_question=str(data.get("pending_question", "")),
                last_assistant_message=str(data.get("last_assistant_message", "")),
                recent_turns=json.dumps(data.get("recent_turns", []), ensure_ascii=False),
                memories=json.dumps(data.get("memories", []), ensure_ascii=False),
                retrieved_context=str(data.get("retrieved_context", "")),
                response_text=str(data.get("response_text", ""))
            ).with_inputs(
                "user_message", "summary", "active_goal", "stage", "pending_question", 
                "last_assistant_message", "recent_turns", "memories", "retrieved_context"
            )
            trainset.append(example)

    print(f"[*] Dataset cargado con {len(trainset)} ejemplos de {dataset_path.name}")
    print("[*] Instanciando RagReplyModule...")
    rag_module = RagReplyModule()
    
    optimizer = BootstrapFewShot(
        metric=dummy_metric, 
        max_bootstrapped_demos=4, 
        max_labeled_demos=16
    )
    
    print(f"[*] Iniciando compilación de DSPy... (Optimizador activado)")
    compiled_rag = optimizer.compile(rag_module, trainset=trainset)
    
    # 5. Guardar Artefactos
    artifacts_dir = settings.artifacts_dir
    if not artifacts_dir.exists() and "dspy_service" in str(artifacts_dir):
         artifacts_dir = Path(__file__).resolve().parent / "artifacts"
    
    artifacts_dir.mkdir(exist_ok=True)
    artifact_path = artifacts_dir / "rag_reply.json"
    meta_path = artifacts_dir / "rag_reply.meta.json"
    
    print(f"[*] Guardando artefacto compilado en {artifact_path}")
    compiled_rag.save(str(artifact_path))
    
    meta_data = {
        "optimizer": "BootstrapFewShot",
        "compiled_at": datetime.utcnow().isoformat(),
        "examples": len(trainset),
        "dataset": "rag_reply.jsonl",
        "model": settings.model
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_data, f, indent=2)
        
    print("[✓] Proceso terminado exitosamente.")

if __name__ == "__main__":
    main()
