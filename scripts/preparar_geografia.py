"""Capas geográficas del tablero: zonas, corregimientos, veredas, barrios y límite de Cartagena.

Zonas, corregimientos y veredas vienen de `GEO_FIELDOPS/datos/curados/` (los archivos
curados de Acuacar). La base no trae barrio: sale del GPS contra los polígonos, o de la
dirección. Cuando el polígono oficial de un barrio cubre menos de la mitad de las órdenes que la dirección dice que son de ese
barrio (o no existe), se reemplaza por uno dibujado con el GPS de esas órdenes.

Ojo con las zonas: el polígono curado no coincide con la columna `zona` de la base
(solo el 61 % de las órdenes con GPS cae en su propia zona). El tablero asigna la zona por
el polígono, según el GPS de cada orden; `scripts/validar.py` mide el cruce con la base.

Uso:  python scripts/preparar_geografia.py
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from shapely import points
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

from geo_util import quitar_sueltas

RAIZ = Path(__file__).resolve().parents[1]
CURADOS = RAIZ.parent / "GEO_FIELDOPS" / "datos" / "curados"
BARRIOS = RAIZ / "cartagena" / "cartagena_barrios.geojson"
SALIDA = RAIZ / "web" / "public" / "geojson"
ALIAS = RAIZ / "config" / "alias_barrios.json"
TABLA = "dbanalitica.historico_acuacar_scr"

CELDA_BARRIO = 0.001   # ~110 m: los barrios son pequeños, las zonas usan celdas más gruesas
MIN_ORDENES_BARRIO = 10  # con menos órdenes no hay cómo dibujar un barrio con sentido
COBERTURA_MINIMA = 0.5   # por debajo, el polígono oficial no representa al barrio

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


def _clave(nombre: str) -> str:
    sin_tildes = "".join(c for c in unicodedata.normalize("NFD", nombre.upper()) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^A-Z0-9]", "", sin_tildes)


def _ordenes_por_barrio_de_direccion() -> dict[str, list[tuple[float, float]]]:
    """GPS de las órdenes agrupado por el barrio que escribe su dirección (clave normalizada)."""
    load_dotenv(RAIZ / ".env")
    alias = {_clave(k): v for k, v in json.loads(ALIAS.read_text(encoding="utf-8")).items()}
    por: dict[str, list[tuple[float, float]]] = defaultdict(list)
    nombres: dict[str, Counter] = defaultdict(Counter)
    patron = re.compile(r"\(([^()]+)\)\s*$")
    with psycopg2.connect(os.environ["DATABASE_URL"]) as con:
        con.set_session(readonly=True)
        cur = con.cursor()
        cur.execute(f"SELECT direccion, latitud, longitud FROM {TABLA} "
                    "WHERE efectividad IN ('Efectiva','No efectiva') "
                    "AND latitud BETWEEN 10 AND 10.8 AND longitud BETWEEN -75.9 AND -75.2")
        for direccion, la, lo in cur.fetchall():
            m = patron.search(direccion or "")
            if not m:
                continue
            nombre = alias.get(_clave(m.group(1)), m.group(1).strip().upper())
            por[_clave(nombre)].append((la, lo))
            nombres[_clave(nombre)][nombre] += 1
    ESCRITURA.update({k: c.most_common(1)[0][0] for k, c in nombres.items()})
    return por


ESCRITURA: dict[str, str] = {}


def _poligono_desde_gps(gps: list[tuple[float, float]]):
    """Celdas con órdenes -> polígono suavizado. Las celdas sueltas (GPS perdidos) no cuentan."""
    por_celda = Counter((int(la // CELDA_BARRIO), int(lo // CELDA_BARRIO)) for la, lo in gps)
    minimo = 2 if len(gps) >= 40 else 1
    celdas = [box(j * CELDA_BARRIO, i * CELDA_BARRIO, (j + 1) * CELDA_BARRIO, (i + 1) * CELDA_BARRIO)
              for (i, j), n in por_celda.items() if n >= minimo]
    union = unary_union(celdas)
    forma = union.buffer(0.0006).buffer(-0.0006).simplify(0.00015)
    # Una orden con GPS lejos del barrio dejaba una celda suelta de ~110 m: no es un polígono
    # del barrio. Se conserva la parte principal y lo que está pegado a ella.
    return quitar_sueltas(forma)


def corregir_barrios(feats: list[dict]) -> list[dict]:
    """Reemplaza los polígonos de barrio que no cubren a sus órdenes por uno dibujado con su GPS."""
    por = _ordenes_por_barrio_de_direccion()
    oficiales: dict[str, list] = defaultdict(list)
    for f in feats:
        oficiales[_clave(f["properties"]["nombre"])].append(shape(f["geometry"]))

    reemplazar: dict[str, object] = {}
    for clave, gps in por.items():
        if len(gps) < MIN_ORDENES_BARRIO:
            continue
        geoms = oficiales.get(clave, [])
        pts = points([p[1] for p in gps], [p[0] for p in gps])
        dentro = sum(1 for p in pts if any(g.intersects(p) for g in geoms)) if geoms else 0
        if dentro / len(gps) < COBERTURA_MINIMA:
            reemplazar[clave] = _poligono_desde_gps(gps)
            print(f"  {ESCRITURA[clave]}: {len(gps)} órdenes, polígono oficial cubre {dentro / len(gps):.0%} -> dibujado con GPS")

    nuevas = [f for f in feats if _clave(f["properties"]["nombre"]) not in reemplazar]
    for clave, geom in reemplazar.items():
        oficial = next((f["properties"]["nombre"] for f in feats if _clave(f["properties"]["nombre"]) == clave), None)
        nuevas.append({"type": "Feature",
                       "properties": {"nombre": oficial or ESCRITURA[clave], "municipio": MUNICIPIO,
                                      "color": "#64748b", "generado": True},
                       "geometry": mapping(geom)})
    return nuevas


def main() -> None:
    SALIDA.mkdir(parents=True, exist_ok=True)
    _escribir("zonas.geojson", zonas())
    _escribir("corregimientos.geojson", rural("cartagena_corregimientos_visor.geojson", "corregimiento_nombre"))
    _escribir("veredas.geojson", rural("cartagena_veredas_visor.geojson", "vereda_nombre"))
    barrios, limite = barrios_y_limite()
    barrios = corregir_barrios(barrios)
    _escribir("barrios.geojson", barrios)
    _escribir("municipios.geojson", limite)


if __name__ == "__main__":
    main()
