"""Carga en memoria el payload que produce el ETL y consume el mapa.

Es la misma fuente que lee el tablero (`web/public/scr/*.json`), así que las
cifras del chat no pueden discrepar de las del mapa: no hay dos cálculos, hay
uno solo leído dos veces.

El payload viene en columnas de enteros: cada orden es una posición `i` en todos
los arrays, y los valores son índices dentro de las listas de `dim`. Se conserva
ese formato —en vez de expandirlo a objetos— porque decenas de miles de órdenes
en arrays de enteros ocupan unos pocos MB y se recorren en milisegundos.
"""

from __future__ import annotations

import json
import logging
from array import array
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Iterator, Sequence

logger = logging.getLogger(__name__)


class PayloadNoDisponible(Exception):
    """No se pudo cargar el payload del ETL."""


@dataclass(frozen=True, slots=True)
class Payload:
    """Las órdenes del tablero, en columnas paralelas."""

    # Catálogos (índice -> nombre)
    barrios: list[str]  # BKEY: "MUNICIPIO | BARRIO (ZONA)"
    munis: list[str]
    zonas: list[str]
    brigs: list[str]
    tecs: list[str]
    tipos: list[str]
    causas: list[str]
    subs: list[str]  # tipo_imposibilidad: la casilla fina del porqué
    tarifas: list[str]  # "11 · RESIDENCIAL ESTRATO 1"
    acts: list[str]
    causa_ctrl: list[int]  # 1 = controlable por la operación
    causa_fam: list[str]
    b_muni: list[int]  # barrio -> municipio
    b_zona: list[int]  # barrio -> zona
    meses: list[str]  # "YYYY-MM", del más antiguo al más reciente
    # Posición global donde arranca cada mes: el NIC de una orden se lee del
    # archivo de su mes, indexado desde 0.
    inicio_mes: list[int]

    # Una posición por orden
    b: array
    t: array
    g: array
    o: array
    c: array
    s: array
    f: array
    a: array
    e: array  # estado: 0 Efectiva, 2 Perdida (el 1, «Fallida», no existe en Acuacar)
    mes: array  # índice en `meses`

    m: array  # minutos desde fecha_min
    fecha_min: str  # YYYY-MM-DD
    fecha_max: str  # YYYY-MM-DD, el último día con gestiones

    generado: str

    def __len__(self) -> int:
        return len(self.e)


_payloads: dict[Path, Payload] = {}
_firmas: dict[Path, tuple] = {}
_lock = Lock()


def _firma_de(directorio: Path) -> tuple:
    """Huella de los archivos, para recargar cuando el ETL los regenere."""
    return tuple(
        (p.name, p.stat().st_mtime_ns, p.stat().st_size)
        for p in sorted(directorio.glob("data*.json"))
    )


def obtener(directorio: Path) -> Payload:
    """Devuelve el payload cacheado, recargándolo si los archivos cambiaron."""
    try:
        firma = _firma_de(directorio)
    except OSError as exc:
        raise PayloadNoDisponible(f"No se pudo leer {directorio}: {exc}") from exc

    with _lock:
        if directorio not in _payloads or firma != _firmas.get(directorio):
            _payloads[directorio] = _cargar(directorio)
            _firmas[directorio] = firma
        return _payloads[directorio]


def _leer_raiz(directorio: Path) -> dict:
    entrada = directorio / "data.json"
    if not entrada.is_file():
        raise PayloadNoDisponible(
            f"Falta {entrada}. Corre `python etl/run_etl.py` o apunta DATA_DIR a la carpeta de los JSON."
        )
    with open(entrada, encoding="utf-8") as fh:
        return json.load(fh)


def _iter_meses(directorio: Path, raiz: dict) -> Iterator[tuple[dict, dict]]:
    """Recorre los meses del manifiesto, del más antiguo al más reciente.

    Devuelve (mes, pts). El mes en curso vive dentro de `data.json` y el resto en
    su propio archivo.
    """
    manifiesto = sorted(raiz["meta"].get("months", []), key=lambda m: m["key"])
    if not manifiesto:
        raise PayloadNoDisponible("El payload no trae manifiesto de meses.")

    for mes in manifiesto:
        if mes.get("recent"):
            yield mes, raiz["pts"]
            continue
        archivo = directorio / mes["file"]
        if not archivo.is_file():
            # Saltárselo daría totales incompletos sin que nadie se entere.
            raise PayloadNoDisponible(f"Falta el archivo del mes {mes['key']}: {archivo}")
        with open(archivo, encoding="utf-8") as fh:
            yield mes, json.load(fh)["pts"]


def _cargar(directorio: Path) -> Payload:
    """Lee `data.json` y los archivos por mes, y los concatena en columnas."""
    raiz = _leer_raiz(directorio)
    dim, meta = raiz["dim"], raiz["meta"]

    meses: list[str] = []
    columnas = {
        "b": array("h"), "t": array("h"), "g": array("b"),
        "o": array("b"), "c": array("b"), "e": array("b"), "mes": array("b"),
        # "h" y no "b" en estos tres aunque hoy quepan: los define el origen, y pasar
        # de 127 valores haría que `extend` lanzara OverflowError y el backend no arrancara.
        "s": array("h"), "f": array("h"), "a": array("h"),
        "m": array("i"),  # minutos desde fecha_min
    }

    inicio_mes: list[int] = []
    for i, (mes, pts) in enumerate(_iter_meses(directorio, raiz)):
        meses.append(mes["key"])
        inicio_mes.append(len(columnas["e"]))
        n = len(pts["e"])
        if n != mes["n"]:
            logger.warning("El mes %s declara %s órdenes y trae %s.", mes["key"], mes["n"], n)
        for clave in ("b", "t", "g", "o", "c", "e", "s", "f", "a", "m"):
            columnas[clave].extend(pts[clave])
        columnas["mes"].extend([i] * n)

    payload = Payload(
        barrios=dim["barrios"], munis=dim["munis"], zonas=dim["zonas"], brigs=dim["brigs"],
        tecs=dim["tecs"], tipos=dim["tipos"], causas=dim["causas"], subs=dim["subs"],
        tarifas=dim["tarifas"], acts=dim.get("acts", []),
        causa_ctrl=dim["causa_ctrl"], causa_fam=dim["causa_fam"],
        b_muni=dim["b_muni"], b_zona=dim["b_zona"],
        meses=meses, inicio_mes=inicio_mes,
        fecha_min=meta.get("fecha_min", ""), fecha_max=meta.get("fecha_max", ""),
        generado=meta.get("generated", ""),
        **columnas,
    )

    esperado = meta.get("total_all")
    if esperado is not None and len(payload) != esperado:
        logger.warning("El payload declara %s órdenes y se cargaron %s.", esperado, len(payload))
    logger.info(
        "Payload cargado: %s órdenes, %s meses, generado el %s.",
        f"{len(payload):,}", len(meses), payload.generado,
    )
    return payload


def leer_nics(directorio: Path, mes: str, posiciones: Sequence[int]) -> dict[int, str]:
    """NIC de unas pocas órdenes, para poder nombrar al cliente de un hallazgo.

    Se lee del archivo del mes en vez de cargar la columna entera en `Payload`:
    son miles de cadenas que solo harían falta para el puñado de filas que se muestran.
    """
    if not posiciones:
        return {}
    raiz = _leer_raiz(directorio)
    entrada = next((m for m in raiz["meta"].get("months", []) if m["key"] == mes), None)
    if entrada is None:
        return {}
    if entrada.get("recent"):
        pts = raiz["pts"]
    else:
        with open(directorio / entrada["file"], encoding="utf-8") as fh:
            pts = json.load(fh)["pts"]
    nics = pts.get("nic") or []
    return {i: nics[i] for i in posiciones if 0 <= i < len(nics)}
