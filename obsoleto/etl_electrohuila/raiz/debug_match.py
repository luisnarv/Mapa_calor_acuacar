from etl.eh_etl.homologacion import clave_homologada
import json

d = json.load(open('web/public/geojson/municipios.geojson', encoding='utf-8'))
nombres_geo = [f['properties']['name'] for f in d['features']]
por_clave = {clave_homologada(n): n for n in nombres_geo}

nombres_db = ['VILLAS DE LA CANDELARIA', '11 DE NOVIEMBRE', 'SANTA LUCIA', 'LA MAGDALENA']
for n in nombres_db:
    print(n, '->', clave_homologada(n) in por_clave)
