"""Taxonomía de negocio: de la causal de no efectividad a causa, familia y controlable.

Una orden *no efectiva* de Acuacar se pierde (no hay categoría «Fallida»). Que la
causa sea controlable decide si cuenta contra la brigada en la efectividad ajustada:
la oposición del usuario y el estado del servicio dependen del cliente, no de quien
visita. Esa partición se acordó con el cliente; cambiarla cambia los rankings.
"""
from __future__ import annotations

# Causal normalizada (`text.norm(...).upper()`) -> (CAUSA legible, FAMILIA, CONTROLABLE 0/1)
CAUSAS: dict[str, tuple[str, str, int]] = {
    "OPOSICION DEL USUARIO":   ("Oposición del usuario",   "seguridad", 0),
    "ESTADO DEL SERVICIO":     ("Estado del servicio",     "normativo", 0),
    "ACCESO O SEGURIDAD":      ("Acceso o seguridad",      "acceso",    1),
    "TECNICA (MEDIDOR O RED)": ("Técnica (medidor o red)", "infra",     1),
    "PREDIO NO UBICABLE":      ("Predio no ubicable",      "datos",     1),
    "RECHAZADA POR MOVILIDAD": ("Rechazada por movilidad", "gestion",   1),
    "OTRAS CAUSAS":            ("Otras causas",            "otros",     1),
}

# Causal nueva o vacía: se asume controlable para exigir de más y no esconder una
# pérdida real detrás de «no era culpa de la brigada».
CAUSA_DESCONOCIDA: tuple[str, str, int] = ("Sin causa registrada", "otros", 1)


def causa_para(clave: str) -> tuple[str, str, int]:
    """Causa, familia y controlable de una causal ya normalizada."""
    return CAUSAS.get(clave, CAUSA_DESCONOCIDA)
