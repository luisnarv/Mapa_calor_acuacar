"""Capas geográficas del tablero: zonas, corregimientos, veredas, barrios y límite de Cartagena.

Zonas, corregimientos y veredas vienen de `GEO_FIELDOPS/datos/curados/` (los archivos
curados de Acuacar). Los barrios son solo referencia visual: la base no trae barrio.

Ojo con las zonas: el polígono curado no coincide con la columna `zona` de la base
(solo el 61 % de las órdenes con GPS cae en su propia zona). El tablero filtra y cuenta
por la zona de la base; el polígono solo se dibuja. `scripts/validar.py` mide ese cruce.

Uso:  python scripts/preparar_geografia.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

RAIZ = Path(__file__).resolve().parents[1]
CURADOS = RAIZ.parent / "GEO_FIELDOPS" / "datos" / "curados"
BARRIOS = RAIZ / "cartagena" / "cartagena_barrios.geojson"
SALIDA = RAIZ / "web" / "public" / "geojson"

COLORES = ("#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6",
           "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#e11d48", "#a855f7", "#eab308",
           "#22c55e", "#0ea5e9", "#d946ef", "#64748b")
MUNICIPIO = "CARTAGENA DE INDIAS"


def _leer(ruta: Path) -> list[dict]:
    with open(ruta, encoding="utf-8") as fh:
        return json.load(fh)["features"]


def _escribir(nombre: str, features: list[dict]) -> None:
    ruta = SALIDA / nombre
    with open(ruta, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh,
                  separators=(",", ":"), ensure_ascii=False)
    print(f"{nombre}: {len(features)} polígonos, {ruta.stat().st_size / 1024:.0f} KB")


def _codigo_zona(crudo: str) -> str:
    """'C011' -> 'C11': la base escribe la zona con dos dígitos, el curado con tres."""
    return "C" + re.sub(r"^C0?", "", crudo).zfill(2)


def zonas() -> list[dict]:
    feats = sorted(_leer(CURADOS / "cartagena_zonas_acuacar.geojson"),
                   key=lambda f: _codigo_zona(f["properties"]["codigoZona"]))
    return [{"type": "Feature",
             "properties": {"zona": _codigo_zona(f["properties"]["codigoZona"]), "color": COLORES[k % len(COLORES)]},
             "geometry": f["geometry"]} for k, f in enumerate(feats)]


def rural(archivo: str, campo: str) -> list[dict]:
    return [{"type": "Feature", "properties": {"nombre": f["properties"][campo].strip().upper()},
             "geometry": f["geometry"]} for f in _leer(CURADOS / archivo)]


def barrios_y_limite() -> tuple[list[dict], list[dict]]:
    feats = [{"type": "Feature",
              "properties": {"nombre": f["properties"]["barrio_nombre"].strip().upper(),
                             "municipio": MUNICIPIO, "color": "#64748b"},
              "geometry": f["geometry"]} for f in _leer(BARRIOS)]
    # Límite del municipio: la unión de los barrios, que es lo único que el mapa necesita
    # para saber dónde empieza «Cartagena»; no se pretende que sea el límite oficial.
    union = unary_union([shape(f["geometry"]) for f in feats]).buffer(0.002).simplify(0.0005)
    limite = [{"type": "Feature", "properties": {"nombre": MUNICIPIO, "color": "#1d4ed8"},
               "geometry": mapping(union)}]
    return feats, limite


def main() -> None:
    SALIDA.mkdir(parents=True, exist_ok=True)
    _escribir("zonas.geojson", zonas())
    _escribir("corregimientos.geojson", rural("cartagena_corregimientos_visor.geojson", "corregimiento_nombre"))
    _escribir("veredas.geojson", rural("cartagena_veredas_visor.geojson", "vereda_nombre"))
    barrios, limite = barrios_y_limite()
    _escribir("barrios.geojson", barrios)
    _escribir("municipios.geojson", limite)


if __name__ == "__main__":
    main()
