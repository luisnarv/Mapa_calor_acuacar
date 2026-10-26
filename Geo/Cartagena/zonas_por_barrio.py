# Genera las zonas de Cartagena UNIENDO (dissolve) los barrios agrupados por la
# zona que les asigna el crosswalk `zona_barrio_limpio.csv` (match por nombre).
#   - Entrada: ../proyectos/cartagena/cartagena_barrios.geojson  +  zona_barrio_limpio.csv
#   - Salida:  ../proyectos/cartagena/cartagena_zonas.geojson (codigoZona)
#              ../proyectos/cartagena/cartagena_barrios.geojson (campo `zona` re-etiquetado)
import geopandas as gpd, pandas as pd, unicodedata
from shapely.geometry import box

BAR = "../proyectos/cartagena/cartagena_barrios.geojson"
ZON = "../proyectos/cartagena/cartagena_zonas.geojson"

def key(s):
    if pd.isna(s): return ""
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return "".join(ch for ch in s.upper() if ch.isalnum())

# 1) crosswalk barrio(key) -> ZONA  (se quita la fila fantasma "ZONA")
csv = pd.read_csv("zona_barrio_limpio.csv")
csv = csv[csv["ZONA"].astype(str).str.upper() != "ZONA"]
lut = dict(zip(csv["k"].map(key), csv["ZONA"].astype(str).str.strip()))
print(f"crosswalk: {len(lut)} barrios | zonas={sorted(set(lut.values()))}")

# --- ajustes manuales -------------------------------------------------------
# override barrio(key) -> zona (se aplica AUNQUE no esté en el CSV, si el
# polígono existe). Ej: Serena del Mar como C01 (hoy no hay polígono de Serena).
OVERRIDE = {
    key("Serena del Mar"): "C01",   # polígono provisional dibujado
    key("Olaya Herrera (Com 5)"): "C07",
    key("Olaya Herrera (Com 6)"): "C07",
    key("Olaya - Sector 11 De Noviembre"): "C06",
    key("Olaya - Sector Rafael Núñez"): "C06",
    key("Olaya Villa Olímpica"): "C06",
    key("Olaya St. Estrella"): "C011",
    key("Chapacuá"): "C014",
    key("Mirador del Nuevo Bosque"): "C013",
    key("Flor del Campo"): "C09",
    key("Urbanizacion Colombiaton"): "C09",
    key("Ciudad Bicentenario"): "C09",
    key("Mamonal"): "C022",
    key("Rubi"): "C014",
    key("Viejo Porvenir"): "C011",
    key("Sectores Unidos"): "C018",
    key("Cesar Florez"): "C017",
    key("Cerro Albornoz"): "C015",
    key("Cerro de la Popa"): "C05",
    key("Villas de Aranjuez"): "C09",
    key("Tesca"): "C06",
    key("San Bernardo"): "C05",
    key("Ararca"): "C015",
    key("Pasacaballos"): "C015",
    key("Santana"): "C015",         # Santa Ana (Barú)
    key("Baru"): "C015",
    key("Zona Industrial"): "C022",  # zona nueva (patrón C0xx)
}
# islas a SACAR (Barú se conserva porque va por OVERRIDE a C15)
EXCLUIR_ISLAS = {key(x) for x in [
    "Tierra Bomba", "Bocachica", "Caño del Oro", "Punta Arenas",
    "Islas del Rosario", "Isla Fuerte", "Isla Mucura", "Isla de León",
    "Archipielago San Bernardo",
]}
# barrios a SACAR explícitamente (quedan sin zona)
EXCLUIR_EXTRA = {key(x) for x in ["Arroyo de las Canoas", "Arroyo Grande", "Las Europas"]}
# ---------------------------------------------------------------------------

# 2) asignar zona a cada barrio por nombre
bar = gpd.read_file(BAR)
bar["k"] = bar["barrio_nombre"].map(key)
bar["zona"] = bar["k"].map(lut)          # base: CSV ("los demás")

# sacar islas (no Barú) + barrios pedidos
quitar = bar["k"].isin(EXCLUIR_ISLAS | EXCLUIR_EXTRA)
print("SACADOS (islas + pedidos):", sorted(bar.loc[quitar, "barrio_nombre"].tolist()))
bar.loc[quitar, "zona"] = None

# overrides manuales (ganan sobre CSV y sobre las exclusiones)
ov = bar["k"].isin(OVERRIDE)
bar.loc[ov, "zona"] = bar.loc[ov, "k"].map(OVERRIDE)
print("OVERRIDES:", sorted(bar.loc[ov, "barrio_nombre"].tolist()),
      "| Serena del Mar presente:", key("Serena del Mar") in set(bar["k"]))

con = bar["zona"].notna().sum()
print(f"\nbarrios={len(bar)} | CON zona={con} | SIN zona={len(bar)-con}")
sin = sorted(bar.loc[bar['zona'].isna(), 'barrio_nombre'].tolist())
print("SIN zona (no están en el CSV):", sin)

# --- limpieza: quita fragmentos < min_m2 y rellena huecos interiores < hueco_min ---
from shapely.geometry import MultiPolygon, Polygon
def limpiar(gdf, min_m2=1000, hueco_min=0):
    g = gdf.to_crs(3116).copy()
    def keep(geom):
        if geom is None or geom.is_empty: return geom
        polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
        big = [p for p in polys if p.area >= min_m2]
        if not big: big = [max(polys, key=lambda p: p.area)]   # no perder la entidad
        if hueco_min > 0:  # rellenar huecos interiores más chicos que hueco_min
            big = [Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= hueco_min]) for p in big]
        out = MultiPolygon(big) if len(big) > 1 else big[0]
        return out.buffer(0)
    g["geometry"] = g.geometry.apply(keep)
    return g.to_crs(4326)

# 3) re-etiquetar barrios (sobrescribe el campo zona) + limpiar geometría
bar_out = limpiar(bar.drop(columns=["k"]))
bar_out.to_file(BAR, driver="GeoJSON")

# 4) barrios PARTIDOS en 2 o MÁS zonas (franjas de igual área)
#    eje 'x': lista de zonas oeste->este | eje 'y': lista sur->norte
SPLIT = {
    key("Trece de Junio"): ("x", ["C014", "C011"]),        # oeste, este
    key("Bosquecito"): ("x", ["C012", "C013"]),            # oeste, este
    key("Alto Bosque"): ("y", ["C012", "C01"]),            # sur, norte
    key("El Bosque"): ("x", ["C012", "C013", "C019"]),     # oeste -> centro -> este
    key("San José de los Campanos"): ("y", ["C017", "C016", "C011"]),  # sur -> centro -> norte
    key("San Fernando"): ("x", ["C019", "C020", "C017"]),  # oeste -> centro -> este
}
def split_n(geom, axis, n):
    minx, miny, maxx, maxy = geom.bounds
    lo, hi = (miny, maxy) if axis == "y" else (minx, maxx)
    total = geom.area
    cuts = []
    for k in range(1, n):                      # n-1 líneas de corte (igual área)
        target, a, b = total * k / n, lo, hi
        for _ in range(45):
            mid = (a + b) / 2
            piece = geom.intersection(box(minx, miny, maxx, mid) if axis == "y" else box(minx, miny, mid, maxy))
            if piece.area < target: a = mid
            else: b = mid
        cuts.append((a + b) / 2)
    edges = [lo] + cuts + [hi]
    parts = []
    for i in range(n):
        clip = box(minx, edges[i], maxx, edges[i + 1]) if axis == "y" else box(edges[i], miny, edges[i + 1], maxy)
        parts.append(geom.intersection(clip).buffer(0))
    return parts

extra = []
for kk, (axis, zones) in SPLIT.items():
    m = bar["k"] == kk
    if not m.any():
        print("SPLIT: no existe", kk); continue
    g = bar.loc[m].geometry.iloc[0].buffer(0)
    bar.loc[m, "zona"] = None   # excluir el barrio entero; solo cuentan las franjas
    for zn, pc in zip(zones, split_n(g, axis, len(zones))):
        extra.append({"zona": zn, "geometry": pc.buffer(0)})
    print(f"SPLIT {kk}: {' + '.join(zones)}")

# 5) dissolve: unir barrios de la misma zona -> polígono de zona
z = bar[bar["zona"].notna()].copy()[["zona", "geometry"]]
z["geometry"] = z.geometry.buffer(0)
if extra:
    z = gpd.GeoDataFrame(pd.concat([z, gpd.GeoDataFrame(extra, crs=z.crs)], ignore_index=True), crs=z.crs)
zonas = (z.dissolve(by="zona", as_index=False)[["zona", "geometry"]]
           .rename(columns={"zona": "codigoZona"}))
zonas["geometry"] = zonas.geometry.buffer(0)
zonas = limpiar(zonas, hueco_min=10000)   # quitar slivers + rellenar huecos < 1 ha
zonas.to_file(ZON, driver="GeoJSON")
print(f"\nZONAS generadas: {len(zonas)} -> {sorted(zonas['codigoZona'])}")
print("barrios por zona:")
print(z.groupby('zona').size().sort_index().to_string())
