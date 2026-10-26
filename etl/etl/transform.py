"""Enriquecimiento del DataFrame crudo: estado, GPS, fecha y causa.

El mapeo de columnas de Acuacar a las que espera el tablero (heredado de Aire) es:
``efectividad`` -> Estado (Efectiva / Perdida; Anulada y Pendiente quedan fuera),
``causal_no_efectiva`` -> ACCION -> CAUSA, ``tipo_imposibilidad`` -> SUBACCION,
``brigada_movilidad`` -> TECNICO y ``proceso`` -> TIPO OS / ACTIVIDAD.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .config import BBOX, TARIFAS_JSON
from .logging_conf import get_logger
from .taxonomy import causa_para
from .text import norm

log = get_logger()

MUNICIPIO = "CARTAGENA DE INDIAS"

# Solo estas dos son órdenes que se intentaron y tienen un resultado. Anulada es
# una orden cancelada y Pendiente una que aún no se ejecuta: contarlas inflaría o
# desinflaría la efectividad.
ESTADO_DE_EFECTIVIDAD: dict[str, str] = {"Efectiva": "Efectiva", "No efectiva": "Perdida"}

COLS_SALIDA: tuple[str, ...] = (
    "ZONA", "ORDEN", "NIC", "MUNICIPIO", "LOCALIDAD/BARRIO", "TARIFA", "TECNICO",
    "TIPO BRIGADA", "TIPO OS", "TIPO SUSPENSION SOLICITADA", "SUBACCION/SUBANOMALIA",
    "ACTIVIDAD", "Estado", "FECHA_EJECUCION", "LATITUD", "LONGITUD",
    "CAUSA", "FAMILIA_CAUSA", "CONTROLABLE",
)


def _por_unico(serie: pd.Series, fn) -> pd.Series:
    """Aplica `fn` una vez por valor único y lo propaga."""
    return serie.map({v: fn(v) for v in pd.unique(serie)})


def _etiqueta_tarifa(codigo: object) -> str | None:
    """'11' -> '11 · RESIDENCIAL ESTRATO 1'. Un código que la tabla oficial no trae se deja visible."""
    if codigo is None or pd.isna(codigo):
        return None
    descripciones = json.loads(TARIFAS_JSON.read_text(encoding="utf-8"))
    return f"{codigo} · {descripciones.get(str(codigo), 'sin descripción en la tabla oficial')}"


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """Aplica estado, GPS válido, fecha y causa. Devuelve `COLS_SALIDA`, sin duplicados."""
    df = df.copy()

    df["Estado"] = df["EFECTIVIDAD"].map(ESTADO_DE_EFECTIVIDAD)
    log.info("Estado: %s Efectiva, %s Perdida; %s fuera del cálculo (Anulada/Pendiente).",
             f"{int((df['Estado'] == 'Efectiva').sum()):,}", f"{int((df['Estado'] == 'Perdida').sum()):,}",
             f"{int(df['Estado'].isna().sum()):,}")
    if df["Estado"].notna().sum() == 0:
        raise RuntimeError("'Estado' quedó vacío en TODAS las filas: revisa los valores de `efectividad`.")

    for col in ("ORDEN", "NIC"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64").astype(str)
    for col in df.columns[df.dtypes == object]:
        df[col] = df[col].map(lambda v: v.strip() if isinstance(v, str) else v)
        df[col] = df[col].replace({"": None, "nan": None, "None": None})

    dentro = df["LATITUD"].between(BBOX[0], BBOX[1]) & df["LONGITUD"].between(BBOX[2], BBOX[3])
    df.loc[~dentro, ["LATITUD", "LONGITUD"]] = np.nan
    log.info("GPS dentro de Cartagena: %s/%s (%.1f%%).",
             f"{int(dentro.sum()):,}", f"{len(df):,}", dentro.mean() * 100 if len(df) else 0)

    df["FECHA_EJECUCION"] = pd.to_datetime(df["FECHA_CIERRE"], errors="coerce").dt.strftime("%Y-%m-%d %H:%M:%S")

    df["TARIFA"] = _por_unico(df["TARIFA"], _etiqueta_tarifa)
    df["MUNICIPIO"] = MUNICIPIO
    df["LOCALIDAD/BARRIO"] = None            # lo pone el GPS en `geo.asignar_territorio`
    df["TIPO SUSPENSION SOLICITADA"] = None  # Acuacar no registra el tipo solicitado
    df["ACTIVIDAD"] = df["TIPO OS"]

    clave = _por_unico(df["ACCION"], lambda a: norm(a).upper())
    lut = {k: causa_para(k) for k in pd.unique(clave)}
    df["CAUSA"] = clave.map({k: v[0] for k, v in lut.items()})
    df["FAMILIA_CAUSA"] = clave.map({k: v[1] for k, v in lut.items()})
    df["CONTROLABLE"] = clave.map({k: v[2] for k, v in lut.items()})
    efectiva = df["Estado"].eq("Efectiva")
    df.loc[efectiva, ["CAUSA", "FAMILIA_CAUSA", "CONTROLABLE"]] = ["Efectiva", "exito", 1]
    df["CONTROLABLE"] = df["CONTROLABLE"].astype(int)

    repetidas = int(df["ORDEN"].duplicated().sum())
    if repetidas:
        df = df.sort_values("FECHA_EJECUCION").drop_duplicates("ORDEN", keep="last")
        log.info("Duplicados: %s órdenes repetidas, se conserva la más reciente.", f"{repetidas:,}")
    return df[list(COLS_SALIDA)]
