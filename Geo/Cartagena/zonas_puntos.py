import pandas as pd, numpy as np, geopandas as gpd
from shapely.geometry import box
from collections import Counter
from shapely.ops import unary_union

df = pd.read_excel("Base zonas.xlsx", sheet_name="Hoja2", usecols=["ZONA","COORDENADAS"])
print("Filas leidas: ", len(df))

c = df["COORDENADAS"].astype(str).str.extract(r"(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)")
df["LAT"] = pd.to_numeric(c[0], errors="coerce")
df["LON"] = pd.to_numeric(c[1], errors="coerce")
df["ZONA"] = df["ZONA"].astype(str).str.strip().str.upper()
df = df[(df["ZONA"]!="") & df["LAT"].between(10.3,10.5) & df["LON"].between(-76,75.5)]
print("Puntos valido: ", len(df), " | Zonas: ", sorted(df["ZONA"].unique()))

CELDA_M = 50

dlat = CELDA_M / 111320
dlon = CELDA_M /(111320 * np.cos(np.radians(df["LAT"].mean())))
lat0, lon0 = df["LAT"].min(), df["LON"].min()
df["FILA"] = np.floor((df["LAT"]-lat0)/dlat).astype(int)
df["COL"] = np.floor((df["LON"]-lon0)/dlon).astype(int)

maj = (df.groupby(["FILA","COL"])["ZONA"].agg(lambda s: Counter(s).most_common(1)[0][0]).reset_index())

print("Celdas con datos: ", len(maj))

def celda_box(r):
    x0 = lon0 + r["COL"]*dlon; y0 = lat0 + r["FILA"]*dlat
    return box(x0, y0, x0+dlon, y0+dlat)
gdf = gpd.GeoDataFrame(maj, geometry = maj.apply(celda_box, axis = 1), crs = 4326)

zonas = gdf.dissolve(by="ZONA", as_index=False)[["ZONA", "geometry"]]
zonas["geometry"] = zonas.geometry.buffer(0)

R = dlon*2
zonas["geometry"] = zonas.geometry.buffer(R).buffer(-R)

acc, geoms = None, []
for _, row in zonas.iterrows():
    g = row.geometry if acc is None else row.geometry.difference(acc)
    geoms.append(g)
    acc = row.geometry if acc is None else unary_union([acc, row.geometry])
zonas["geometry"] = geoms
zonas = zonas[~zonas.geometry.is_empty]

pts = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df["LON"], df["LAT"]), crs=4326)

bar = gpd.read_file("..\\proyectos\\cartagena\\cartagena_barrios.geojson")[["barrio_nombre","geometry"]].reset_index(drop=True)
bar["bid"] = bar.index
bar["geometry"] = bar.geometry.buffer(0)

j = gpd.sjoin(pts[["ZONA","geometry"]], bar[["bid","geometry"]], how="inner", predicate="within")
zs = j.groupby("bid")["ZONA"].agg(lambda s: set(s))

unicos = zs[zs.map(len)== 1]
barU = bar[bar["bid"].isin(unicos.index)].copy()
barU["ZONA"] = barU["bid"].map(unicos.map(lambda s: next(iter(s))))
print("Barrios de una sola zona: ", len(barU), " de ", len(bar))

quitar = unary_union(barU.geometry.values)
zonas["geometry"] = zonas.geometry.difference(quitar)

comb = gpd.GeoDataFrame(
    pd.concat([barU[["ZONA", "geometry"]], zonas[["ZONA","geometry"]]], ignore_index=True)
    , crs =4326)
comb["geometry"] = comb.geometry.buffer(0)
zonas = comb.dissolve(by="ZONA", as_index=False)


zonas = zonas.rename(columns = {"ZONA":"codigoZona"})

zonas.to_file("..\\proyectos\\cartagena\\cartagena_zonas.geojson", driver="GeoJSON")
print("Listo ", len(zonas), " zonas ->", sorted(zonas["codigoZona"]))