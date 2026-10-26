import sys
import re

with open('etl/eh_etl/geografia.py', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace the __init__ method using regex to avoid exact character match issues
pattern = re.compile(r'    def __init__\(self, gj: dict\[str, Any\]\) -> None:.*?def __len__\(self\) -> int:', re.DOTALL)

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
        log.info("Capa municipios: %d poligonos, zonas %s.", len(self.features), sorted(set(self.zonas)))

    def __len__(self) -> int:'''

if pattern.search(text):
    text = pattern.sub(new_init, text)
    with open('etl/eh_etl/geografia.py', 'w', encoding='utf-8') as f:
        f.write(text)
    print('Patched successfully')
else:
    print('Pattern not found')
