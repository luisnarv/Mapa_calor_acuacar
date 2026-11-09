"""Corregimiento por GPS y `b_corr`: el filtro Ubicación necesita uno por barrio.

La base no trae corregimiento; sale de `corregimientos.geojson`. Si `b_corr` no queda alineado
con `barrios`, el tablero asigna el corregimiento de un barrio a otro sin avisar.
"""
import json

import pytest

pd = pytest.importorskip("pandas", reason="El ETL requiere pandas.")
pytest.importorskip("shapely", reason="El ETL requiere shapely.")
geo = pytest.importorskip("etl.geo")
payload = pytest.importorskip("etl.payload")


def cuadro(nombre: str, lon0: float, lat0: float) -> dict:
    lado = 0.1
    anillo = [[lon0, lat0], [lon0 + lado, lat0], [lon0 + lado, lat0 + lado], [lon0, lat0 + lado], [lon0, lat0]]
    return {"type": "Feature", "properties": {"nombre": nombre},
            "geometry": {"type": "Polygon", "coordinates": [anillo]}}


@pytest.fixture
def geojson(tmp_path):
    ruta = tmp_path / "corregimientos.geojson"
    ruta.write_text(json.dumps({"type": "FeatureCollection", "features": [
        cuadro("BAYUNCA", -75.5, 10.5), cuadro("ARROYO GRANDE", -75.3, 10.5)]}), encoding="utf-8")
    return ruta


def ordenes(*puntos: tuple[float, float]) -> pd.DataFrame:
    return pd.DataFrame({"LONGITUD": [p[0] for p in puntos], "LATITUD": [p[1] for p in puntos]})


def test_el_gps_dentro_del_poligono_toma_su_corregimiento(geojson):
    d = geo.asignar_corregimiento(ordenes((-75.45, 10.55), (-75.25, 10.55)), geojson)

    assert list(d["CORREGIMIENTO"]) == ["BAYUNCA", "ARROYO GRANDE"]


def test_fuera_de_todo_poligono_es_cabecera_municipal(geojson):
    d = geo.asignar_corregimiento(ordenes((-75.9, 10.0)), geojson)

    assert list(d["CORREGIMIENTO"]) == ["Cabecera municipal"]


def test_sin_el_geojson_todo_es_cabecera_municipal(tmp_path):
    d = geo.asignar_corregimiento(ordenes((-75.45, 10.55)), tmp_path / "no_existe.geojson")

    assert list(d["CORREGIMIENTO"]) == ["Cabecera municipal"]


def test_b_corr_tiene_el_mismo_largo_que_barrios():
    d = pd.DataFrame({"b": [0, 1, 2], "CORREGIMIENTO": ["BAYUNCA", "BAYUNCA", None]})

    corrs, b_corr = payload.corregimientos_por_barrio(d, 3)

    assert len(b_corr) == 3
    assert all(0 <= i < len(corrs) for i in b_corr)


def test_barrio_sin_corregimiento_cae_en_cabecera_municipal():
    d = pd.DataFrame({"b": [0, 1, 2], "CORREGIMIENTO": [None, "", "  "]})

    corrs, b_corr = payload.corregimientos_por_barrio(d, 3)

    assert {corrs[i] for i in b_corr} == {"Cabecera municipal"}


def test_gana_el_corregimiento_mas_frecuente_del_barrio():
    d = pd.DataFrame({"b": [0, 0, 0], "CORREGIMIENTO": ["BAYUNCA", "BAYUNCA", "BARU"]})

    corrs, b_corr = payload.corregimientos_por_barrio(d, 1)

    assert corrs[b_corr[0]] == "BAYUNCA"
