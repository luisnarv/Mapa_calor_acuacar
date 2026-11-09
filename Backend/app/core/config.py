"""Variables de entorno con Pydantic. Única fuente de configuración."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_DIR = BACKEND_ROOT / "app" / "prompts"
# Los JSON que escribe el ETL y lee el tablero: una sola copia para el mapa y el chat.
DATOS_POR_DEFECTO = BACKEND_ROOT.parent / "web" / "public" / "scr"


def leer_prompt(nombre: str) -> str:
    """Lee un prompt de `app/prompts/`.

    Falla al arrancar si no está, en vez de dejar al asistente sin instrucciones
    y que se note cuando alguien pregunte algo raro.
    """
    ruta = PROMPTS_DIR / nombre
    if not ruta.is_file():
        raise RuntimeError(
            f"Falta el prompt {ruta}. Sin él el asistente responde sin reglas: "
            "restaura el archivo antes de arrancar."
        )
    return ruta.read_text(encoding="utf-8").strip()


class Settings(BaseSettings):
    # `.env` junto al backend; `extra="ignore"` deja pasar las variables de otros servicios.
    model_config = SettingsConfigDict(env_file=BACKEND_ROOT / ".env", extra="ignore")

    PROJECT_NAME: str = "SCR Acuacar API"
    API_V1_PREFIX: str = "/api/v1"

    DATA_DIR: Path = DATOS_POR_DEFECTO

    OPENAI_API_KEY: str
    OPENAI_MODEL: str = "gpt-4.1-mini"
    OPENAI_TIMEOUT_SECONDS: float = 60.0
    OPENAI_MAX_RETRIES: int = 2
    OPENAI_SYSTEM_PROMPT: str = leer_prompt("sistema.md")

    # El tablero corre en :3100 (ver .claude/launch.json) y, por defecto de Next, en :3000.
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3100,http://127.0.0.1:3100"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    """Cacheado: se lee el entorno una sola vez por proceso."""
    return Settings()


settings = get_settings()
