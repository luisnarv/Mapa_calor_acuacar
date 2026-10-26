"""Carga de las capas preparadas por `scripts/preparar_geografia.py`.

Tres capas, todas en EPSG:4326:

* **municipios** — 42 polígonos con nombre, zona y punto representativo. Es la
  unidad de agregación del mapa (ver README: no hay geometría de barrio que
  cubra el área; Neiva, que es el 49 % de los registros, no aparece en las capas
  de manzana ni de perímetro urbano).
* **zonas** — las cuatro zonas operativas, con su color.
* **perímetros** — 85 perímetros urbanos y centros poblados, capa de referencia.

GeoJSON viene en [lon, lat] y Leaflet quiere [lat, lon]: `anillos()` hace el
cambio una sola vez, al construir el payload.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .logging_conf import get_logger

log = get_logger()


def leer(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        log.warning("No encuentro %s. Corre antes scripts/preparar_geografia.py.", path)
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def anillos(geom: dict[str, Any]) -> list:
    def flip(c):
        if not c: return []
        if isinstance(c[0], (int, float)): return [round(c[1], 5), round(c[0], 5)]
        return [flip(x) for x in c]
    res = flip(geom["coordinates"])
    # Ensure 4 levels of nesting: list of lists of lists of lists of floats
    def depth(lst):
        return 1 + depth(lst[0]) if isinstance(lst, list) and lst else 0
    d = depth(res)
    while d < 4 and d > 0:
        res = [res]
        d += 1
    return res


class CapaMunicipios:
    """Los 42 municipios: geometría, zona y punto representativo.

    Expone el índice espacial (`shapely.STRtree`) que resuelve el punto en
    polígono, que es como se ubica cada registro con GPS real.
    """

    def __init__(self, gj: dict[str, Any]) -> None:
        from shapely.geometry import shape
        from shapely.validation import make_valid
        from shapely.strtree import STRtree
        
        from shapely.ops import unary_union
        
        self._formas = []
        self.features = []
        
        for f in gj["features"]:
            self.features.append(f)
        self.nombres = [f["properties"].get("name", "SIN NOMBRE") for f in self.features]
        self.zonas = [f["properties"].get("zona_codigo", "SIN ZONA") for f in self.features]
        self.codigos = [f["properties"].get("codigo") for f in self.features]
        self.puntos = [(f["properties"].get("lat", 10.4), f["properties"].get("lon", -75.5)) for f in self.features]
        self._arbol = STRtree(self._formas)
        log.info("Capa municipios: %d poligonos, zonas %s.", len(self.features), sorted(set(z for z in self.zonas if z is not None)))

    def __len__(self) -> int:
        return len(self.features)

    def contiene(self, lons, lats):
        """Índice del municipio que contiene cada punto, o -1. Vectorizado."""
        import numpy as np
        import shapely as sh

        puntos = sh.points(lons, lats)
        pares = self._arbol.query(puntos, predicate="within")
        salida = np.full(len(lons), -1, dtype=np.int32)
        salida[pares[0]] = pares[1]
        return salida

    def poligonos(self) -> list[dict[str, Any]]:
        """Polígonos listos para el payload: {n, m, b, cf, r}.

        Mismo contrato que usaba el mapa original para los límites de barrio:
        `b` es el índice de la unidad y `cf` la confianza del enlace. Aquí el
        enlace es exacto (el polígono ES la unidad), así que `cf` siempre es 1.
        """
        return [
            {
                "n": self.nombres[i],
                "m": self.zonas[i],
                "b": i,
                "cf": 1,
                "r": anillos(f["geometry"]),
            }
            for i, f in enumerate(self.features)
        ]


def cargar_zonas(path: Path) -> list[dict[str, Any]]:
    """Polígonos de zona para el payload: {n, c, r}."""
    gj = leer(path)
    if gj is None:
        return []
    zp = [{"n": f["properties"].get("zona", ""),
           "c": f["properties"].get("color", ""),
           "r": anillos(f["geometry"])}
          for f in gj["features"]]
    log.info("Capa zonas: %d polígonos.", len(zp))
    return zp


def cargar_perimetros(path: Path) -> list[dict[str, Any]]:
    """Perímetros urbanos y centros poblados para el payload: {n, m, r}."""
    gj = leer(path)
    if gj is None:
        return []
    mp = [{"n": f["properties"].get("nombre") or f["properties"].get("name", ""),
           "m": f["properties"].get("municipio", ""),
           "r": anillos(f["geometry"])}
          for f in gj["features"]]
    log.info("Capa perímetros urbanos: %d polígonos.", len(mp))
    return mp
