"""Orquestación: PostgreSQL -> transformación -> geolocalización -> JSON."""
from __future__ import annotations

import json
import time
from typing import Any

from .clasificacion import Clasificador
from .config import Settings, consulta
from .database import Database
from .geografia import CapaMunicipios, leer
from .geolocalizar import geolocalizar
from .logging_conf import get_logger
from .payload import build_and_write
from .transformar import enrich

log = get_logger()


def run(settings: Settings) -> dict[str, Any]:
    """Corre el ETL de punta a punta y devuelve el resumen de la corrida."""
    inicio = time.perf_counter()
    log.info("=" * 66)
    log.info("ETL Acuacar — mapa de calor")
    log.info("Tabla de origen: %s", settings.tabla)
    log.info("=" * 66)

    clasificador = Clasificador.desde(settings.homologacion)

    ciclos = {}
    if settings.ciclos.exists():
        with open(settings.ciclos, encoding="utf-8") as fh:
            ciclos = json.load(fh).get("ciclos", {})
        log.info("Fichas de ciclo: %d (de Ciclos de Suspensión y SECTORES-2).", len(ciclos))
    else:
        log.warning("Falta %s; el ciclo se mostrará sin descripción. "
                    "Corre `python scripts/preparar_ciclos.py`.", settings.ciclos)

    gj = leer(settings.geo_municipios)
    if gj is None:
        raise RuntimeError(
            f"Falta {settings.geo_municipios}. Corre antes "
            "`python scripts/preparar_geografia.py`."
        )
    capa = CapaMunicipios(gj)

    with Database(settings.database_url) as db:
        filas = db.comprobar(settings.tabla)
        log.info("%s tiene %s filas.", settings.tabla, f"{filas:,}")
        crudo = db.fetch(consulta(settings.tabla))

    enriquecido = enrich(crudo, clasificador, ciclos)
    ubicadas, informe = geolocalizar(enriquecido, capa)
    informe["ciclo"] = _informe_ciclo(enriquecido, ciclos)
    resumen = build_and_write(ubicadas, capa, informe, settings, ciclos)

    log.info("=" * 66)
    log.info("OK  %s registros en el mapa · %d unidades · %.1fs",
             f"{resumen['total']:,}", resumen["unidades"], time.perf_counter() - inicio)
    log.info("=" * 66)
    resumen["ubicacion"] = informe
    return resumen


def _informe_ciclo(d, ciclos: dict[str, dict]) -> dict[str, Any]:
    """Indicador de calidad: ¿el municipio de la orden coincide con su ciclo?

    Es solo un indicador. `SECTORES-2.xlsx` está incompleto —los ciclos rurales
    grandes tocan en la base más municipios de los que lista— así que no se usa
    para descartar nada.
    """
    from .homologacion import clave_homologada

    coincide = discrepa = sin_referencia = 0
    for ciclo, muni in zip(d["CICLO_NUM"], d["MUNICIPIO"]):
        ficha = ciclos.get(str(int(ciclo))) if ciclo == ciclo else None
        refs = (ficha or {}).get("municipios") or []
        if not refs:
            sin_referencia += 1
        elif clave_homologada(muni) in refs:
            coincide += 1
        else:
            discrepa += 1
    log.info("Ciclo vs municipio (referencia SECTORES-2): %s coinciden, "
             "%s discrepan, %s sin referencia.",
             f"{coincide:,}", f"{discrepa:,}", f"{sin_referencia:,}")
    return {
        "municipio_coincide": coincide,
        "municipio_discrepa": discrepa,
        "ciclo_sin_referencia": sin_referencia,
        "nota": ("SECTORES-2.xlsx está incompleto; esto es un indicador de "
                 "calidad, no un criterio para descartar órdenes."),
    }
