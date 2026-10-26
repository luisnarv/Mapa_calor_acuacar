"""Capa geográfica: límites de barrio/municipio/zona y su enlace con las órdenes.

Las órdenes se enlazan a los polígonos catastrales por **geometría** (punto en
polígono), no por nombre: el nombre solo cruzaba el 46% de las órdenes; la
geometría cruza el 99,8%. Lógica idéntica al `Index.py` original.
"""
from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .logging_conf import get_logger

log = get_logger()


def _cargar_geojson(path: Path) -> dict[str, Any] | None:
    """Lee un GeoJSON; devuelve None (con aviso) si no existe."""
    if not path.exists():
        log.warning("No encuentro %s. Se omite esa capa.", path.name)
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _anillos(geom: dict[str, Any]) -> list:
    """GeoJSON usa [lon,lat]; Leaflet quiere [lat,lon]. Devuelve polígonos->anillos."""
    tipo, coords = geom["type"], geom["coordinates"]
    polis = [coords] if tipo == "Polygon" else coords
    return [
        [[[round(p[1], 5), round(p[0], 5)] for p in anillo] for anillo in poli]
        for poli in polis
    ]


def _sin_tildes(texto: str) -> str:
    """'MANATÍ' -> 'MANATI': la base escribe los municipios sin tilde, los geojson con ella."""
    return "".join(c for c in unicodedata.normalize("NFKD", texto) if not unicodedata.combining(c))


def asignar_territorio(d: pd.DataFrame, path_barrios: Path, path_municipios: Path) -> pd.DataFrame:
    """Corrige MUNICIPIO y barrio de cada gestión con lo que dice su GPS.

    El nombre de barrio de la base no es confiable: puede traer un barrio de
    Soledad pegado a un municipio que no es. Aquí manda el punto: si cae dentro
    de un polígono de barrio, se toman su nombre y su municipio; si solo cae en un
    municipio, se corrige el municipio y se deja el barrio de la base; si no cae
    en nada, no se toca. El municipio de un polígono se saca del polígono de
    municipio que contiene su punto interior, no de su propiedad `municipio`,
    porque el geojson de barrios trae tildes dañadas ("SANTO TOM�S").

    Requiere ``LATITUD``/``LONGITUD`` y un índice de posiciones 0..n-1.
    """
    gb, gm = _cargar_geojson(path_barrios), _cargar_geojson(path_municipios)
    if gb is None or gm is None:
        return d
    try:
        import shapely as _sh
        from shapely.geometry import shape
        from shapely.strtree import STRtree
    except ImportError:
        log.warning("Falta 'shapely'. Se dejan MUNICIPIO y barrio como vienen de la base.")
        return d

    formas_b = [shape(f["geometry"]) for f in gb["features"]]
    formas_m = [shape(f["geometry"]) for f in gm["features"]]
    nom_b = np.array([f["properties"].get("nombre", "") for f in gb["features"]], dtype=object)
    nom_m = np.array([_sin_tildes(f["properties"].get("nombre", "")) for f in gm["features"]], dtype=object)
    arbol_m = STRtree(formas_m)
    arbol_b = STRtree(formas_b)

    # Municipio de cada polígono de barrio (por su punto interior).
    muni_de_b = np.array([_sin_tildes(f["properties"].get("municipio", "")) for f in gb["features"]], dtype=object)
    interior = _sh.points(np.array([[g.representative_point().x, g.representative_point().y] for g in formas_b]))
    ib, im = arbol_m.query(interior, predicate="within")
    muni_de_b[ib] = nom_m[im]
    # Los que quedan fuera de todo municipio (borde mal dibujado) toman el más cercano.
    sin = np.setdiff1d(np.arange(len(formas_b)), ib)
    if len(sin):
        ib2, im2 = arbol_m.query_nearest(interior[sin])
        muni_de_b[sin[ib2]] = nom_m[im2]

    puntos = _sh.points(d["LONGITUD"].values, d["LATITUD"].values)
    en_muni = np.full(len(d), -1)
    pm = arbol_m.query(puntos, predicate="within")
    en_muni[pm[0]] = pm[1]
    en_barrio = np.full(len(d), -1)
    pb = arbol_b.query(puntos, predicate="within")
    en_barrio[pb[0]] = pb[1]

    muni = d["MUNICIPIO"].to_numpy(dtype=object).copy()
    barrio = d["LOCALIDAD/BARRIO"].to_numpy(dtype=object).copy()
    ok = en_muni >= 0
    muni[ok] = nom_m[en_muni[ok]]
    ok = en_barrio >= 0
    muni[ok] = muni_de_b[en_barrio[ok]]
    barrio[ok] = nom_b[en_barrio[ok]]

    cambian = int((muni != d["MUNICIPIO"].to_numpy(dtype=object)).sum())
    log.info("Territorio por GPS: %s de %s gestiones con municipio corregido; "
             "%s dentro de un barrio oficial.", f"{cambian:,}", f"{len(d):,}", f"{int(ok.sum()):,}")
    d = d.copy()
    d["MUNICIPIO"], d["LOCALIDAD/BARRIO"] = muni, barrio
    # Marca qué nombres vienen de un polígono: `unificar_barrios` los prefiere.
    d["_BARRIO_POLIGONO"] = ok
    return d


def asignar_zona(d: pd.DataFrame, path_zonas: Path) -> pd.DataFrame:
    """Pone en ZONA la del polígono curado que contiene el GPS de cada orden.

    Se decidió que manda el polígono y no la columna `zona` de la base, aunque difieran
    (coinciden en ~61 % de las órdenes). Fuera de todo polígono queda «SIN ZONA»; si un
    punto cae en dos (borde compartido) gana el polígono de código menor, para que el
    resultado no dependa del orden en que el índice espacial devuelve los pares.
    La zona de la base se conserva en ZONA_BASE por si hay que auditar la diferencia.
    """
    gz = _cargar_geojson(path_zonas)
    if gz is None:
        raise RuntimeError(f"Sin {path_zonas.name} no se puede asignar la zona: corre scripts/preparar_geografia.py.")
    import shapely as _sh
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    feats = sorted(gz["features"], key=lambda f: f["properties"]["zona"])
    nombres = np.array([f["properties"]["zona"] for f in feats], dtype=object)
    arbol = STRtree([shape(f["geometry"]) for f in feats])
    puntos = _sh.points(d["LONGITUD"].values, d["LATITUD"].values)
    i_punto, i_poli = arbol.query(puntos, predicate="intersects")
    elegido = np.full(len(d), len(nombres))  # len(nombres) = sin polígono
    np.minimum.at(elegido, i_punto, i_poli)
    zona = np.append(nombres, "SIN ZONA")[elegido]

    d = d.copy()
    d["ZONA_BASE"] = d["ZONA"]
    d["ZONA"] = zona
    iguales = int((d["ZONA"] == d["ZONA_BASE"]).sum())
    log.info("Zona por polígono: %s de %s órdenes coinciden con la zona de la base; %s quedan fuera de todo polígono.",
             f"{iguales:,}", f"{len(d):,}", f"{int((zona == 'SIN ZONA').sum()):,}")
    return d


def link_barrios(d: pd.DataFrame, path: Path) -> list[dict[str, Any]]:
    """Enlaza cada polígono de barrio con el barrio del dato por mayoría geométrica.

    Args:
        d: DataFrame indexado; requiere columnas ``b`` (índice de barrio),
            ``LATITUD`` y ``LONGITUD``.
        path: ruta al GeoJSON de barrios.

    Returns:
        Lista de polígonos ``{n, m, b, cf, r}`` (nombre, municipio, índice de
        barrio enlazado o -1, confianza, anillos). Lista vacía si no hay geojson
        o falta shapely.
    """
    gj = _cargar_geojson(path)
    if gj is None:
        return []
    try:
        import shapely as _sh
        from shapely.geometry import shape
        from shapely.strtree import STRtree
    except ImportError:
        log.warning("Falta 'shapely' (pip install shapely). Sin límites de barrio.")
        return []

    formas = [shape(f["geometry"]) for f in gj["features"]]
    arbol = STRtree(formas)
    puntos = _sh.points(d["LONGITUD"].values, d["LATITUD"].values)
    pares = arbol.query(puntos, predicate="within")
    asignacion = np.full(len(d), -1)
    asignacion[pares[0]] = pares[1]
    d = d.reset_index(drop=True)
    d["_poly"] = asignacion
    fuera = int((asignacion < 0).sum())

    # Voto de mayoría: barrio del dato -> polígono con más de sus órdenes.
    enlace: dict[int, list[tuple[int, int, int]]] = {}
    for bidx, grp in d[d["_poly"] >= 0].groupby("b"):
        vc = grp["_poly"].value_counts()
        enlace.setdefault(int(vc.index[0]), []).append((int(bidx), int(vc.iloc[0]), len(grp)))

    # Un polígono puede recibir varios barrios del dato: se queda con el mayor.
    pol2b: dict[int, tuple[int, float]] = {}
    for poly, candidatos in enlace.items():
        bidx, n, total = max(candidatos, key=lambda x: x[1])
        pol2b[poly] = (bidx, round(n / total, 2))

    bpoly: list[dict[str, Any]] = []
    bajos = 0
    for i, feature in enumerate(gj["features"]):
        props = feature["properties"]
        bidx, cf = pol2b.get(i, (-1, 0))
        if cf and cf < 0.6:
            bajos += 1
        bpoly.append({
            "n": props.get("nombre", ""),
            "m": props.get("municipio", ""),
            "b": bidx,
            "cf": cf,
            "r": _anillos(feature["geometry"]),
        })

    enlazados = sum(1 for p in bpoly if p["b"] >= 0)
    dentro = len(d) - fuera
    log.info("Límites de barrio: %d polígonos, %d enlazados. %s/%s órdenes dentro (%.1f%%).",
             len(bpoly), enlazados, f"{dentro:,}", f"{len(d):,}",
             dentro / len(d) * 100 if len(d) else 0)
    if bajos:
        log.warning("%d polígonos con enlace de baja confianza (<60%%).", bajos)
    return bpoly


def load_municipios(path: Path) -> list[dict[str, Any]]:
    """Carga los polígonos de municipio: ``{n, r}``."""
    gj = _cargar_geojson(path)
    if gj is None:
        return []
    mpoly = [{"n": f["properties"].get("nombre", ""), "r": _anillos(f["geometry"])}
             for f in gj["features"]]
    log.info("Límites de municipio: %d polígonos.", len(mpoly))
    return mpoly


def load_zonas(path: Path) -> list[dict[str, Any]]:
    """Carga los polígonos de zona: ``{n, c, r}`` (nombre, color, anillos)."""
    gj = _cargar_geojson(path)
    if gj is None:
        return []
    zpoly = [{"n": f["properties"].get("zona", ""),
              "c": f["properties"].get("color", ""),
              "r": _anillos(f["geometry"])}
             for f in gj["features"]]
    log.info("Límites de zona: %d polígonos.", len(zpoly))
    return zpoly
