"""Utilidades de geometría compartidas por los scripts de geografía (sin base de datos)."""
from __future__ import annotations

from shapely.geometry import MultiPolygon

# ~330 m en grados. Una parte más lejos que esto de la parte principal del barrio no es del
# barrio: es una orden con GPS fuera de él (un NIC que cayó lejos).
DISTANCIA_MAXIMA = 0.003


def quitar_sueltas(geom, distancia: float = DISTANCIA_MAXIMA):
    """Deja la parte mayor del polígono y las que están pegadas a ella; descarta las sueltas.

    «Pegadas» es encadenado: una parte a menos de `distancia` de cualquiera de las ya
    conservadas se queda. Una geometría de una sola parte vuelve igual.
    """
    partes = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    if len(partes) < 2:
        return geom
    partes.sort(key=lambda p: p.area, reverse=True)
    quedan, resto = [partes[0]], partes[1:]
    cambio = True
    while cambio and resto:
        cambio = False
        for p in list(resto):
            if any(p.distance(q) <= distancia for q in quedan):
                quedan.append(p)
                resto.remove(p)
                cambio = True
    return quedan[0] if len(quedan) == 1 else MultiPolygon(quedan)
