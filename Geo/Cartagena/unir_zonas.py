import geopandas as gpd
from shapely.ops import unary_union

M = 3116
z = gpd.read_file("..\\proyectos\\cartagena\\cartagena_zonas.geojson").rename(columns={"codigo_zona":"ZONA"}).to_crs(M)
z["geometry"] = z.geometry.buffer(0)

R = 120

orig = list(z.geometry)
nuevas = []
for i in range(len(z)):
    otras = unary_union([orig[k] for k in range(len(z)) if k != i])
    puente = orig[i].buffer(R).buffer(-R)

    puente = puente.difference(otras)
    nuevas.append(puente.buffer(0))
z["geometry"] = nuevas

acc, geoms = None, []
for g in z.geometry:
    gg = g if acc is None else g.difference(acc)
    geoms.append(gg)
    acc = g if acc is None else unary_union([acc, g])
z["geometry"] = geoms
z = z[~z.geometry.is_empty]

z = z.to_crs(4326).rename(columns={"ZONA":"codigoZona"})
z.to_file("..\\proyectos\\cartagena\\cartagena_zonas.geojson", driver="GeoJSON")
print("Zonas: ", sorted(z["codigoZona"]))