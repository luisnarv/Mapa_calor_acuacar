import sys

with open('etl/eh_etl/geografia.py', 'r', encoding='utf-8') as f:
    text = f.read()

import re

old_init = '''    def __init__(self, gj: dict[str, Any]) -> None:
        from shapely.geometry import shape
        from shapely.ops import unary_union
        from shapely.strtree import STRtree
        
        self._formas = []
        valid_features = []
        
        # Group by zona_codigo
        zonas_dict = {}
        for f in gj["features"]:
            try:
                s = shape(f["geometry"])
                from shapely.validation import make_valid
                s = make_valid(s)
                zona_code = f["properties"].get("zona_codigo", "SIN ZONA")
                if zona_code not in zonas_dict:
                    zonas_dict[zona_code] = []
                zonas_dict[zona_code].append(s)
            except Exception:
                pass
                
        for zona_code, shapes in zonas_dict.items():
            self._formas.append(unary_union(shapes))
            valid_features.append({"properties": {"name": zona_code, "zona_codigo": zona_code, "lat": 10.4, "lon": -75.5}})

        self.features = valid_features
        self.nombres = [f["properties"].get("name") for f in self.features]
        self.zonas = [f["properties"].get("zona_codigo") for f in self.features]
        self.codigos = [f["properties"].get("codigo") for f in self.features]
        self.puntos = [(f["properties"].get("lat", 10.4), f["properties"].get("lon", -75.5)) for f in self.features]
        self._arbol = STRtree(self._formas)
        log.info("Capa municipios: %d polígonos, zonas %s.",
                 len(self.features), sorted(set(self.zonas)))'''

new_init = '''    def __init__(self, gj: dict[str, Any]) -> None:
        from shapely.geometry import shape
        from shapely.validation import make_valid
        from shapely.strtree import STRtree
        
        self._formas = []
        self.features = []
        for f in gj["features"]:
            try:
                s = shape(f["geometry"])
                s = make_valid(s)
                self._formas.append(s)
                self.features.append(f)
            except Exception:
                pass
                
        self.nombres = [f["properties"].get("name") for f in self.features]
        self.zonas = [f["properties"].get("zona_codigo") for f in self.features]
        self.codigos = [f["properties"].get("codigo") for f in self.features]
        self.puntos = [(f["properties"].get("lat", 10.4), f["properties"].get("lon", -75.5)) for f in self.features]
        self._arbol = STRtree(self._formas)
        log.info("Capa municipios: %d polígonos, zonas %s.",
                 len(self.features), sorted(set(self.zonas)))'''

if old_init in text:
    text = text.replace(old_init, new_init)
    with open('etl/eh_etl/geografia.py', 'w', encoding='utf-8') as f:
        f.write(text)
    print('Patched successfully')
else:
    print('Could not find old_init')
