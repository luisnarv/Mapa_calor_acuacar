"""Esquemas de las métricas operativas y del filtro que se aplica al mapa."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Efectividad(BaseModel):
    """Métricas de un barrio, zona, técnico o del total.

    `ef_pct` es la efectividad cruda y `ef_adj` la ajustada (excluye del
    denominador las órdenes no controlables). El tablero usa la cruda en los
    tooltips del mapa y la ajustada para ordenar rankings. Acuacar solo tiene
    dos estados: Efectiva y Perdida.
    """

    nombre: str
    municipio: str | None = None
    tot: int
    ef: int
    pe: int
    noctrl: int
    ef_pct: float = Field(description="Efectividad cruda: ef / tot")
    ef_adj: float = Field(description="Efectividad ajustada: ef / (tot - no controlables)")
    # Solo se llenan en los rankings: ponderar exige una media del conjunto con
    # la que comparar, y una consulta de un solo sitio no tiene conjunto.
    ef_pond: float | None = Field(
        default=None,
        description="Efectividad ponderada por volumen: acerca a la media a quien tiene poca muestra.",
    )
    ef_adj_pond: float | None = Field(
        default=None,
        description="La ajustada, ponderada por volumen igual que `ef_pond`.",
    )


class FilaCausa(BaseModel):
    causa: str
    familia: str
    n: int
    pct: float
    controlable: bool


class CandidatoBarrio(BaseModel):
    bkey: str
    barrio: str
    municipio: str
    tot: int


Capa = Literal[
    "gps", "calor", "aproximadas", "marcadores", "sin_nic",
    "poligonos_barrios", "poligonos_municipios", "poligonos_corregimientos",
    "poligonos_veredas", "poligonos_zonas",
]


class FiltroMapa(BaseModel):
    """Filtro que el frontend aplica al tablero.

    Los valores son **nombres**, no índices: el backend no conoce el orden de
    las dimensiones del payload, así que la traducción la hace el frontend.
    """

    barrio: str | None = Field(default=None, description="BKEY 'MUNICIPIO | BARRIO (ZONA)'")
    barrios: list[str] | None = Field(
        default=None, description="Varios barrios a la vez, cada uno como BKEY 'MUNICIPIO | BARRIO (ZONA)'."
    )
    tecnicos: list[str] | None = Field(
        default=None, description="Técnicos elegidos, tal como están en el catálogo."
    )
    municipio: str | None = None
    zona: str | None = None
    corregimiento: str | None = Field(
        default=None, description="Corregimiento (nombre del catálogo, p. ej. «Cabecera municipal»)."
    )
    brigada: str | None = None
    actividad: str | None = None
    tipo_os: str | None = None
    capas: list[Capa] | None = Field(
        default=None, description="Capas del mapa que se encienden."
    )
    capas_apagar: list[Capa] | None = Field(
        default=None, description="Capas del mapa que se apagan."
    )
    estados: list[Literal["efectiva", "perdida"]] | None = Field(
        default=None,
        description="Estados de orden que se muestran. Solo «efectiva»: oculta las perdidas, y al revés.",
    )
    minimo_ordenes: int | None = Field(
        default=None, ge=1, le=500, description="Mínimo de órdenes para que un barrio entre a la cola de riesgo."
    )
    umbral_hotspot: int | None = Field(
        default=None, ge=10, le=95, description="Riesgo desde el cual un barrio se marca como crítico."
    )
    ajustada: bool | None = Field(
        default=None, description="true: riesgo sobre pérdidas controlables; false: sobre todas."
    )
    meses: list[str] | None = Field(default=None, description="Claves YYYY-MM")
