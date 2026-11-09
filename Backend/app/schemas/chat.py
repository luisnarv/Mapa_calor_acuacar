"""Esquemas Pydantic del chat con OpenAI: contrato de entrada y salida."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

Role = Literal["system", "user", "assistant"]


class Message(BaseModel):
    role: Role
    content: str = Field(min_length=1, max_length=32_000)


class VistaTablero(BaseModel):
    """Lo que el usuario tiene en pantalla cuando escribe.

    Sin esto el chat responde sobre todo el histórico mientras la persona mira un
    mes y una zona concretos, y las dos cifras se contradicen sin que nadie
    entienda por qué. Llega en **nombres**, no en índices: el backend no conoce el
    orden de las dimensiones del payload.
    """

    barrio: str | None = Field(default=None, description="BKEY 'MUNICIPIO | BARRIO (ZONA)'")
    barrios: list[str] = Field(
        default_factory=list, description="Barrios filtrados a la vez, como BKEY 'MUNICIPIO | BARRIO (ZONA)'."
    )
    tecnicos: list[str] = Field(
        default_factory=list, description="Técnicos elegidos en el tablero."
    )
    municipio: str | None = None
    zona: str | None = None
    brigada: str | None = None
    tipo_os: str | None = None
    actividad: str | None = None
    meses: list[str] = Field(default_factory=list, description="Claves YYYY-MM")

    def resumen(self) -> str:
        """Descripción legible para el prompt. Cadena vacía si no hay filtros."""
        partes = [
            (etiqueta, valor)
            for etiqueta, valor in (
                ("barrio", self.barrio),
                ("barrios", "; ".join(self.barrios) if self.barrios else None),
                ("técnicos", "; ".join(self.tecnicos) if self.tecnicos else None),
                ("municipio", self.municipio),
                ("zona", self.zona),
                ("brigada", self.brigada),
                ("tipo de orden", self.tipo_os),
                ("actividad", self.actividad),
                ("meses", ", ".join(self.meses) if self.meses else None),
            )
            if valor
        ]
        return " · ".join(f"{k}: {v}" for k, v in partes)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=50)
    vista: VistaTablero | None = Field(
        default=None, description="Filtros activos en el tablero del usuario."
    )
    conversacion_id: UUID | None = Field(
        default=None,
        description=(
            "Id de la conversación, generado por el cliente. Hoy no se usa: queda "
            "para agrupar el feedback cuando se agregue."
        ),
    )
    model: str | None = Field(
        default=None, description="Si se omite, se usa OPENAI_MODEL del entorno."
    )
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=16_000)


class Usage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatResponse(BaseModel):
    content: str
    model: str
    finish_reason: str | None = None
    usage: Usage | None = None
    acciones: list[dict] = Field(
        default_factory=list, description="Filtros que el frontend debe aplicar al tablero."
    )
