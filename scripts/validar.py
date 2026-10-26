"""Cruza lo que escribió el ETL en web/public/scr/ contra la base, con SQL independiente.

Uso:  python scripts/validar.py     (sale con código 1 si algo no cuadra)

Comprueba, sobre las órdenes con estado, GPS en Cartagena y fecha: total por estado,
por causa, por zona (la del polígono curado, que es la que manda) y por mes. Es la prueba de que el tablero muestra lo que dice la base.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

RAIZ = Path(__file__).resolve().parents[1]
SCR = RAIZ / "web" / "public" / "scr"
TABLA = "dbanalitica.historico_acuacar_scr"
FECHA = "COALESCE(fecha_finalizacion, fecha_imposibilidad, fecha_apertura)"
UNIVERSO = (f"efectividad IN ('Efectiva','No efectiva') AND latitud BETWEEN 10 AND 10.8 "
            f"AND longitud BETWEEN -75.9 AND -75.2 AND {FECHA} IS NOT NULL")


def _pts() -> tuple[dict, dict]:
    data = json.loads((SCR / "data.json").read_text(encoding="utf-8"))
    pts = {k: list(v) for k, v in data["pts"].items()}
    for mes in data["meta"]["months"]:
        if "file" in mes:
            extra = json.loads((SCR / mes["file"]).read_text(encoding="utf-8"))["pts"]
            for k in pts:
                pts[k] += extra[k]
    return data, pts


def _sql(cur, sql: str) -> dict:
    cur.execute(sql)
    return {r[0]: r[1] for r in cur.fetchall()}


def main() -> int:
    load_dotenv(RAIZ / ".env")
    data, pts = _pts()
    dim = data["dim"]
    json_ = {
        "estado": Counter(dim["estados"][e] for e in pts["e"]),
        "causa": Counter(dim["causas"][c] for c in pts["c"] if dim["causas"][c] != "Efectiva"),
        "zona": Counter(dim["zonas"][dim["b_zona"][b]] for b in pts["b"]),
        "mes": Counter({m["key"]: m["n"] for m in data["meta"]["months"]}),
    }
    con = psycopg2.connect(os.environ["DATABASE_URL"])
    con.set_session(readonly=True)
    cur = con.cursor()
    base = {
        "estado": _sql(cur, f"SELECT CASE efectividad WHEN 'Efectiva' THEN 'Efectiva' ELSE 'Perdida' END, COUNT(*) FROM {TABLA} WHERE {UNIVERSO} GROUP BY 1"),
        "causa": _sql(cur, f"SELECT causal_no_efectiva, COUNT(*) FROM {TABLA} WHERE {UNIVERSO} AND efectividad='No efectiva' GROUP BY 1"),
        "zona": _sql(cur, f"SELECT zona, COUNT(*) FROM {TABLA} WHERE {UNIVERSO} GROUP BY 1"),
        "mes": _sql(cur, f"SELECT to_char({FECHA},'YYYY-MM'), COUNT(*) FROM {TABLA} WHERE {UNIVERSO} GROUP BY 1"),
    }
    cur.execute(f"SELECT zona, latitud, longitud FROM {TABLA} WHERE {UNIVERSO}")
    ordenes = cur.fetchall()
    con.close()
    por_poligono = _zonas_por_poligono(ordenes)
    base["zona"] = dict(Counter(por_poligono))

    fallos = 0
    for dim_nombre, esperado in base.items():
        obtenido = dict(json_[dim_nombre])
        if dim_nombre == "causa":  # la base trae NULL cuando no hay causal; el ETL la llama «Sin causa registrada»
            esperado = {(k or "Sin causa registrada"): v for k, v in esperado.items()}
            obtenido = {k: v for k, v in obtenido.items()}
            # Compara por conteo ordenado: los nombres legibles difieren de los de la base.
            esperado, obtenido = sorted(esperado.values()), sorted(obtenido.values())
        ok = esperado == obtenido
        fallos += not ok
        print(f"{'OK ' if ok else 'ERR'} {dim_nombre}: {esperado if not ok else 'coincide'}"
              + ("" if ok else f"  vs  {obtenido}"))
    print(_informe_zonas(ordenes, por_poligono))
    return 1 if fallos else 0


def _zonas_por_poligono(ordenes: list[tuple]) -> list[str]:
    """Zona de cada orden según el polígono curado que contiene su GPS (menor código si son varios)."""
    from shapely import points
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    feats = sorted(json.loads((RAIZ / "web" / "public" / "geojson" / "zonas.geojson").read_text(encoding="utf-8"))["features"],
                   key=lambda f: f["properties"]["zona"])
    nombres = [f["properties"]["zona"] for f in feats]
    arbol = STRtree([shape(f["geometry"]) for f in feats])
    por: list[list[int]] = [[] for _ in ordenes]
    pts = points([o[2] for o in ordenes], [o[1] for o in ordenes])
    for i_punto, i_poli in arbol.query(pts, predicate="intersects").T.tolist():
        por[i_punto].append(i_poli)
    return [nombres[min(idx)] if idx else "SIN ZONA" for idx in por]


def _informe_zonas(ordenes: list[tuple], por_poligono: list[str]) -> str:
    """Informativo: cuánto difiere la zona del polígono de la columna `zona` de la base."""
    iguales = sum(1 for o, z in zip(ordenes, por_poligono) if o[0] == z)
    sin = sum(1 for z in por_poligono if z == "SIN ZONA")
    return (f"INFO zona por polígono vs base: {iguales / len(ordenes):.1%} coincide; "
            f"{sin / len(ordenes):.1%} ({sin:,}) queda fuera de todo polígono (SIN ZONA)")


if __name__ == "__main__":
    sys.exit(main())
