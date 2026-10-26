"""Orquestación del ETL: BD -> transformación -> JSON del mapa."""
from __future__ import annotations

import time
from typing import Any

from .config import QUERY_HISTORICO, Settings
from .database import fetch_ordenes
from .logging_conf import get_logger
from .payload import build_and_write
from .transform import enrich

log = get_logger()


def run(settings: Settings) -> dict[str, Any]:
    """Ejecuta el ETL de punta a punta y devuelve el resumen de la corrida."""
    inicio = time.perf_counter()
    df = enrich(fetch_ordenes(settings.database_url, QUERY_HISTORICO))
    resumen = build_and_write(df, settings)
    log.info("OK  total_all=%s  |  %.1fs", f"{resumen['total_all']:,}", time.perf_counter() - inicio)
    return resumen
