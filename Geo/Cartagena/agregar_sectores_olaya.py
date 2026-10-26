# Trae barrios "finos" desde la capa OSM y los agrega a cartagena_barrios.geojson,
# RECORTÁNDOLOS de cualquier barrio IGAC que solapen (para que no haya doble cobertura).
# El campo `zona` lo asigna después zonas_por_barrio.py vía OVERRIDE.
# Lee el OSM manualmente (cierra anillos) porque geopandas rechaza sus rings abiertos.
import geopandas as gpd, unicodedata, pandas as pd, json
from shapely.geometry import shape
from shapely.ops import unary_union

BAR = "../proyectos/cartagena/cartagena_barrios.geojson"
OSM = "../proyectos/cartagena/cartagena_barrios_osm.geojson"

# nombres EXACTOS en la capa OSM que queremos traer como barrios
ADD = [
    "Olaya - Sector 11 De Noviembre", "Olaya - Sector Rafael Núñez",
    "Olaya Villa Olímpica", "Olaya St. Estrella",
    "Chapacuá",
]

def key(s):
    if pd.isna(s): return ""
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return "".join(ch for ch in s.upper() if ch.isalnum())

def close_rings(g):
    def cl(coords):
        for ring in coords:
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
    if g["type"] == "Polygon": cl(g["coordinates"])
    elif g["type"] == "MultiPolygon":
        for poly in g["coordinates"]: cl(poly)
    return g

osm = json.load(open(OSM, encoding="utf-8"))
want = {n: None for n in ADD}
for f in osm["features"]:
    if f["properties"].get("name") in want:
        want[f["properties"]["name"]] = shape(close_rings(f["geometry"])).buffer(0)

bar = gpd.read_file(BAR)
bar["geometry"] = bar.geometry.buffer(0)
existing = set(bar["barrio_nombre"].map(key))
tpl = bar.iloc[0].drop(labels=["geometry"]).to_dict()

add = []
for nm, geom in want.items():
    if geom is None:
        print("NO encontrado en OSM:", nm); continue
    upper = nm.upper()
    if key(upper) in existing:
        print("ya existe:", upper); continue
    # recortar de todos los barrios que solape
    ov = bar.geometry.intersects(geom)
    bar.loc[ov, "geometry"] = bar.loc[ov].geometry.apply(lambda g: g.difference(geom).buffer(0))
    props = dict(tpl)
    props.update({"barrio_nombre": upper, "barrio_codigo": "OSM_FINO",
                  "fuente": "OSM (barrio fino)", "zona": None})
    add.append({**props, "geometry": geom})
    print("agregado:", upper, "| recortado de", int(ov.sum()), "barrios")

if add:
    bar = gpd.GeoDataFrame(pd.concat([bar, gpd.GeoDataFrame(add, crs=bar.crs)], ignore_index=True), crs=bar.crs)
print("total barrios:", len(bar))
bar.to_file(BAR, driver="GeoJSON")
