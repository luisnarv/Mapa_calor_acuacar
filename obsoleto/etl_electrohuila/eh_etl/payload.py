"""Construcción del JSON que consume el visor.

Formato heredado del tablero original (mismas letras, mismos arrays) para que la
lógica del mapa —filtros en TypedArrays, agregación, índice de riesgo— siga
siendo la misma. Lo que cambia es de dónde sale cada dimensión:

    b   unidad geográfica  "ZONA | MUNICIPIO"      (antes: "MUNICIPIO | BARRIO")
    t   funcionario                                (antes: técnico)
    g   causal de suspensión                       (antes: tipo de brigada)
    o   clase de servicio                          (antes: tipo de OS)
    c   causa = observación de la visita           (igual)
    s   suspensión en                              (antes: subacción)
    u   ubicación urbano/rural                     (antes: tipo de suspensión)
    f   estrato                                    (antes: tarifa)
    e   estado 0 Efectiva / 1 Fallida / 2 Perdida  (igual)
    m   minutos desde la fecha mínima              (igual)
    n   número de documento                        (antes: número de orden)
    nic cuenta                                     (antes: NIC)
    ap  1 si la ubicación es aproximada            (nuevo: antes se adivinaba
                                                    en el navegador por GPS
                                                    repetidos; ahora lo dice el
                                                    ETL, que sí lo sabe)

El mes en curso viaja dentro de `data.json`; los demás en un archivo por mes que
el visor descarga solo si se selecciona.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd

from .config import LAT0, LON0, MESES_ES, Settings
from .geografia import CapaMunicipios, cargar_perimetros, cargar_zonas
from .geolocalizar import ORIGEN_GPS
from .homologacion import (
    ETIQUETA_GRUPO,
    GRUPOS,
    GRUPOS_DENOMINADOR,
    GRUPOS_NUMERADOR,
    grupo_de,
)
from .logging_conf import get_logger

log = get_logger()

# Columna del DataFrame -> letra del array en el JSON.
DIMENSIONES: tuple[tuple[str, str], ...] = (
    ("BKEY", "b"), ("FUNCIONARIO", "t"), ("CAUSAL", "g"), ("CLASE_SERVICIO", "o"),
    ("OBSERVACION", "c"), ("SUSPENSION_EN", "s"), ("UBICACION", "u"),
    ("ESTRATO", "f"), ("ESTADO_ORDEN", "x"), ("REGLA", "rg"),
    ("MOTIVO_UBICACION", "mo"), 
    ("OPERACION", "op"), ("BRIGADA", "br"), ("ACTIVIDAD", "ac"),
)


def _indice(serie: pd.Series) -> tuple[list[str], dict[str, int]]:
    vals = sorted(serie.dropna().astype(str).unique().tolist())
    return vals, {v: i for i, v in enumerate(vals)}


def _mes_label(ym: str) -> str:
    y, mo = ym.split("-")
    return f"{MESES_ES[int(mo) - 1]} de {y}"


def _pts(df: pd.DataFrame) -> dict[str, list]:
    """Arrays compactos de un subconjunto de filas."""
    return {
        "la": ((df["LATITUD"] - LAT0) * 1e5).round().astype("int64").tolist(),
        "lo": ((df["LONGITUD"] - LON0) * 1e5).round().astype("int64").tolist(),
        "e": df["e"].tolist(),
        "b": df["b"].tolist(),
        "t": df["t"].tolist(),
        "g": df["g"].tolist(),
        "o": df["o"].tolist(),
        "c": df["c"].tolist(),
        "s": df["s"].tolist(),
        "u": df["u"].tolist(),
        "f": df["f"].tolist(),
        "m": df["m"].tolist(),
        "ap": df["ap"].tolist(),
        # Trazabilidad: estado crudo, regla que clasificó, motivo de la
        # ubicación y grupo operativo del resultado.
        "x": df["x"].tolist(),
        "rg": df["rg"].tolist(),
        "mo": df["mo"].tolist(),
        "gr": df["gr"].tolist(),
        "op": df["op"].tolist(),
        "br": df["br"].tolist(),
        "ac": df["ac"].tolist(),
        # Días entre la suspensión y la reconexión; -1 cuando no hubo.
        "dr": df["DIAS_RECONEXION"].fillna(-1).round().astype(int).tolist(),
        "n": df["DOCUMENTO"].tolist(),
        "nic": df["CUENTA"].tolist(),
    }


def _preparar(d: pd.DataFrame, capa: CapaMunicipios, anios: tuple[int, ...] | None) -> pd.DataFrame:
    """Deja solo las filas dibujables y arma la clave de la unidad geográfica."""
    antes = len(d)
    d = d[d["RESULTADO"].notna() & d["FECHA"].notna()].copy()
    if len(d) < antes:
        log.info("Sin resultado o sin fecha: %s filas fuera del mapa.",
                 f"{antes - len(d):,}")

    if anios:
        previo = len(d)
        d = d[d["FECHA"].dt.year.isin(anios)]
        log.info("Filtro de años %s: quedan %s de %s.", list(anios),
                 f"{len(d):,}", f"{previo:,}")

    d = d.sort_values("FECHA").reset_index(drop=True)

    # La unidad es el municipio; la clave lleva la zona delante para que el
    # visor pueda mostrar "MUNICIPIO · Zona" sin otra tabla de por medio.
    d["MUNI_NOMBRE"] = d["UNIDAD"].map(lambda i: capa.nombres[i])
    d["ZONA_NOMBRE"] = d["UNIDAD"].map(lambda i: capa.zonas[i])
    d["BKEY"] = d["ZONA_NOMBRE"].astype(str) + " | " + d["MUNI_NOMBRE"].astype(str)
    d["ap"] = (d["ORIGEN"] != ORIGEN_GPS).astype(int)

    for col in ("FUNCIONARIO", "CAUSAL", "CLASE_SERVICIO", "OBSERVACION",
                "SUSPENSION_EN", "UBICACION", "ESTRATO", "ESTADO_ORDEN",
                "REGLA", "MOTIVO_UBICACION", "RESULTADO", "GRUPO",
                "OPERACION", "BRIGADA", "ACTIVIDAD"):
        d[col] = d[col].fillna("SIN DATO")
    return d


def build_and_write(d: pd.DataFrame, capa: CapaMunicipios, informe: dict,
                    settings: Settings,
                    ciclos: dict[str, dict] | None = None) -> dict[str, Any]:
    """Arma el payload completo y lo escribe en `web/public/`."""
    d = _preparar(d, capa, settings.anios)
    if d.empty:
        raise RuntimeError("No quedan filas dibujables; no se genera el mapa.")

    # --- Dimensiones ------------------------------------------------------
    unidades, ui = _indice(d["BKEY"])
    funcs, ti = _indice(d["FUNCIONARIO"])
    causales, gi = _indice(d["CAUSAL"])
    clases, oi = _indice(d["CLASE_SERVICIO"])
    observaciones, ci = _indice(d["OBSERVACION"])
    suspen, si = _indice(d["SUSPENSION_EN"])
    ubic, uui = _indice(d["UBICACION"])
    estratos, fi = _indice(d["ESTRATO"])
    estados_orden, xi = _indice(d["ESTADO_ORDEN"])
    reglas, ri = _indice(d["REGLA"])
    motivos, moi = _indice(d["MOTIVO_UBICACION"])


    # El resultado del diccionario es la dimensión que parte el mapa. Se ordena
    # por grupo operativo para que la leyenda salga agrupada sola.
    operaciones, opi = _indice(d["OPERACION"])
    brigadas, bri = _indice(d["BRIGADA"])
    actividades, aci = _indice(d["ACTIVIDAD"])
    resultados = sorted(d["RESULTADO"].unique(),
                        key=lambda r: (GRUPOS.index(grupo_de(r)), r))
    resultado_idx = {r: i for i, r in enumerate(resultados)}

    munis = sorted(set(capa.nombres))
    zonas = sorted(set(capa.zonas))

    mapas = {
        "BKEY": ui, "FUNCIONARIO": ti, "CAUSAL": gi, "CLASE_SERVICIO": oi,
        "OBSERVACION": ci, "SUSPENSION_EN": si, "UBICACION": uui, "ESTRATO": fi,
        "ESTADO_ORDEN": xi, "REGLA": ri, "MOTIVO_UBICACION": moi,
        "OPERACION": opi, "BRIGADA": bri, "ACTIVIDAD": aci,
    }
    for col, letra in DIMENSIONES:
        d[letra] = d[col].map(mapas[col]).fillna(0).astype(int)
    d["e"] = d["RESULTADO"].map(resultado_idx).astype(int)
    d["gr"] = d["GRUPO"].map({g: i for i, g in enumerate(GRUPOS)}).astype(int)

    d["FECHA"] = d["FECHA"].dt.tz_localize(None)
    t0 = pd.Timestamp(d["FECHA"].min().date())
    d["m"] = ((d["FECHA"] - t0).dt.total_seconds() // 60).astype("int64")

    # --- La unidad y su municipio / zona ----------------------------------
    muni_idx = {n: i for i, n in enumerate(munis)}
    zona_idx = {n: i for i, n in enumerate(zonas)}
    unidad_a_capa = {}
    for _, fila in d.drop_duplicates("b")[["b", "UNIDAD"]].iterrows():
        unidad_a_capa[int(fila["b"])] = int(fila["UNIDAD"])

    b_muni, b_zona, bc = [], [], []
    for i in range(len(unidades)):
        cap_i = unidad_a_capa[i]
        b_muni.append(muni_idx[capa.nombres[cap_i]])
        b_zona.append(zona_idx[capa.zonas[cap_i]])
        # Centro de la unidad: la mediana de sus GPS reales si los hay (cae
        # donde de verdad está la operación) y si no, el punto representativo
        # del polígono.
        grp = d[(d["b"] == i) & (d["ap"] == 0)]
        if len(grp) >= 5:
            bc.append([round(float(grp["LATITUD"].median()), 5),
                       round(float(grp["LONGITUD"].median()), 5)])
        else:
            bc.append([capa.puntos[cap_i][0], capa.puntos[cap_i][1]])

    # --- Centro de cada ciclo ---------------------------------------------

    # --- Geografía: polígonos de las unidades que sí tienen registros ------
    usadas = {unidad_a_capa[i]: i for i in range(len(unidades))}
    bpoly = []
    for p in capa.poligonos():
        p = dict(p)
        p["b"] = usadas.get(p["b"], -1)   # -1 = municipio sin registros
        bpoly.append(p)
    mpoly = cargar_perimetros(settings.geo_perimetros)
    zpoly = cargar_zonas(settings.geo_zonas)

    # --- Partición por mes -------------------------------------------------
    d["ym"] = d["FECHA"].dt.strftime("%Y-%m")
    ultimo = d["ym"].max()
    reciente = d[d["ym"] == ultimo]
    settings.salida.mkdir(parents=True, exist_ok=True)

    manifiesto: list[dict[str, Any]] = []
    por_mes: dict[str, int] = {}
    for ym in sorted(d["ym"].unique()):
        grp = d[d["ym"] == ym]
        por_mes[ym] = len(grp)
        if ym == ultimo:
            manifiesto.append({"key": ym, "label": _mes_label(ym),
                               "n": int(len(grp)), "recent": True})
        else:
            fname = f"data_{ym}.json"
            _escribir(settings.salida / fname, {"pts": _pts(grp)})
            manifiesto.append({"key": ym, "label": _mes_label(ym),
                               "n": int(len(grp)), "file": fname})

    log.info("Meses: %d (%s .. %s). Último en curso: %s con %s filas.",
             len(manifiesto), manifiesto[0]["key"], manifiesto[-1]["key"],
             ultimo, f"{len(reciente):,}")

    data = {
        "meta": {
            "total": int(len(reciente)),
            "total_all": int(len(d)),
            "fecha_min": str(d["FECHA"].min())[:10],
            "fecha_max": str(d["FECHA"].max())[:10],
            "lat0": LAT0,
            "lon0": LON0,
            "generated": str(pd.Timestamp.today().date()),
            "fuente": settings.tabla,
            "months": manifiesto,
            "ubicacion": informe,
        },
        "dim": {
            "barrios": unidades,          # unidades geográficas: "ZONA | MUNICIPIO"
            "tecs": funcs,
            "brigs": causales,
            "tipos": clases,
            "causas": observaciones,
            "subs": suspen,
            "susps": ubic,
            "tarifas": estratos,
            "munis": munis,
            "zonas": zonas,
            # --- Clasificación según el diccionario oficial ----------------
            "estados": resultados,                 # el resultado de cada orden
            "grupos": list(GRUPOS),                # su grupo operativo
            "grupoEtiqueta": [ETIQUETA_GRUPO[g] for g in GRUPOS],
            "estadoGrupo": [GRUPOS.index(grupo_de(r)) for r in resultados],
            # Qué grupos entran al numerador y al denominador de la efectividad.
            "grupoNumerador": [int(g in GRUPOS_NUMERADOR) for g in GRUPOS],
            "grupoDenominador": [int(g in GRUPOS_DENOMINADOR) for g in GRUPOS],
            # --- Trazabilidad ----------------------------------------------
            "estadosOrden": estados_orden,         # el `estado` crudo de la base
            "reglas": reglas,                      # qué regla clasificó la orden
            "motivos": motivos,                    # por qué quedó donde quedó
            "motivoTexto": [informe["glosario_motivos"].get(m, m) for m in motivos],
            # --- De la guía de observaciones -------------------------------
            "operaciones": operaciones,
            "brigadas": brigadas,
            "actividades": actividades,
            "b_muni": b_muni,
            "b_zona": b_zona,
            # Rótulos de los filtros: el visor no tiene que saber qué columna
            # de Acuacar hay detrás de cada letra.
            "etiquetas": {
                "unidad": "Barrio",
                "unidadPadre": "Zona",
                "tecs": "Funcionario",
                "brigs": "Proceso",
                "tipos": "Clase de servicio",
                "causas": "Observación de la visita",
                "subs": "Suspensión en",
                "resultado": "Resultado",
                "actividades": "Actividad",
                "operaciones": "Operación en campo",
                "brigadas": "Brigada",
                "susps": "Ubicación",
                "tarifas": "Estrato",
                "orden": "Documento",
                "nic": "Cuenta",
            },
        },
        "geo": {"bc": bc, "bp": bpoly, "mp": mpoly, "zp": zpoly,},
        "pts": _pts(reciente),
    }

    destino = settings.salida / "data.json"
    _escribir(destino, data)
    log.info("data.json -> %s (%.2f MB)", destino, destino.stat().st_size / 1e6)

    return {"total": int(len(d)), "meses": por_mes, "unidades": len(unidades)}


def _escribir(path: Path, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)
