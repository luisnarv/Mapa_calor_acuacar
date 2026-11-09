"""Quita de `web/public/geojson/barrios.geojson` las partes sueltas de los barrios dibujados con GPS.

`preparar_geografia.py` ya no las genera; este script arregla un archivo producido antes, sin
necesitar la base de datos. Solo toca los barrios `generado: true` (los oficiales no se tocan).

Uso:  python scripts/limpiar_barrios_sueltos.py
"""
from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import mapping, shape

from geo_util import quitar_sueltas

ARCHIVO = Path(__file__).resolve().parents[1] / "web" / "public" / "geojson" / "barrios.geojson"


def main() -> None:
    gj = json.loads(ARCHIVO.read_text(encoding="utf-8"))
    quitadas = tocados = 0
    for f in gj["features"]:
        if not f["properties"].get("generado"):
            continue
        antes = shape(f["geometry"])
        despues = quitar_sueltas(antes)
        n0 = len(antes.geoms) if antes.geom_type == "MultiPolygon" else 1
        n1 = len(despues.geoms) if despues.geom_type == "MultiPolygon" else 1
        if n1 < n0:
            f["geometry"] = mapping(despues)
            quitadas += n0 - n1
            tocados += 1
            print(f"  {f['properties']['nombre']}: {n0} partes -> {n1}")
    ARCHIVO.write_text(json.dumps(gj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{quitadas} partes sueltas quitadas en {tocados} barrios.")


if __name__ == "__main__":
    main()
