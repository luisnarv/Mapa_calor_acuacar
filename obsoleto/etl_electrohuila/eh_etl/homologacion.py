"""Homologaciones que NO salen del diccionario de códigos.

La clasificación del resultado de cada orden vive en `clasificacion.py` y se
alimenta de `Diccionario_codigos_acuacar.xlsx`. Aquí queda lo que ese
archivo no cubre:

1. **Municipios**: el nombre que trae la base contra el nombre del IGAC.
2. **Agrupación operativa**: cómo se reparten los siete resultados del
   diccionario en los cuatro grupos que colorean el mapa y que definen la
   efectividad.
3. **Etiquetas sueltas** de columnas sin diccionario.
"""
from __future__ import annotations

import unicodedata

# --------------------------------------------------------------------------
# 1. Municipios
# --------------------------------------------------------------------------

def clave_municipio(nombre: object) -> str:
    """Nombre de municipio reducido a letras y números sin tildes.

    'Yaguará' y 'YAGUARA' dan la misma clave, que es lo que permite cruzar el
    nombre de la base con el del IGAC sin mantener una tabla de 42 entradas.
    """
    if nombre is None:
        return ""
    s = unicodedata.normalize("NFD", str(nombre))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return "".join(c for c in s.upper() if c.isalnum())


# Lo que la normalización por sí sola no resuelve: nombres comerciales que no
# coinciden con el del IGAC.
ALIAS_MUNICIPIO: dict[str, str] = {
    "ELPITAL": "PITAL",
    "BELALCAZARPAEZ": "PAEZ",
    "BELALCAZAR": "PAEZ",
}


def clave_homologada(nombre: object) -> str:
    """Clave de municipio ya pasada por los alias."""
    k = clave_municipio(nombre)
    return ALIAS_MUNICIPIO.get(k, k)


# --------------------------------------------------------------------------
# 2. Agrupación operativa de los resultados
# --------------------------------------------------------------------------
#
# El diccionario clasifica cada orden en uno de siete resultados. Para el mapa
# hacen falta dos cosas más que el diccionario no da, y que son decisión de
# negocio, no de dato:
#
#   · con qué color se dibuja cada resultado en el mapa de calor;
#   · qué cuenta como «efectivo» al calcular la efectividad y el riesgo.
#
# Las dos salen de esta tabla, que es el ÚNICO juicio propio del proyecto sobre
# los resultados. Está aquí, a la vista y en un solo lugar, precisamente para
# que se pueda discutir y cambiar sin tocar nada más.
#
#   ejecutada     la orden terminó con el servicio suspendido
#   no_ejecutable la cuadrilla fue y no pudo: es lo que la operación debe bajar
#   no_procedia   no había que suspender (pagó, está en gestión, era reconexión)
#   sin_dato      el diccionario dice que no hay información suficiente
#
GRUPOS: tuple[str, ...] = ("ejecutada", "no_ejecutable", "no_procedia", "sin_dato")

GRUPO_POR_RESULTADO: dict[str, str] = {
    "SUSPENDIDO": "ejecutada",
    "SE MANTIENE SUSPENDIDO": "ejecutada",
    "NO ES POSIBLE SUSPENDER": "no_ejecutable",
    "PAGÓ": "no_procedia",
    "GESTIÓN DE COBRO": "no_procedia",
    "ACTA DE RECONEXIÓN": "no_procedia",
    "SIN INFORMACIÓN": "sin_dato",
    "SIN CLASIFICAR": "sin_dato",
    "Ordenes de suspensión": "ejecutada",
    "Reconexión Impagados": "no_procedia",
}

# Nombre legible de cada grupo, para la interfaz.
ETIQUETA_GRUPO: dict[str, str] = {
    "ejecutada": "Suspensión ejecutada",
    "no_ejecutable": "No fue posible suspender",
    "no_procedia": "No procedía suspender",
    "sin_dato": "Sin información",
}

# La efectividad se mide solo contra las órdenes que de verdad había que
# ejecutar: las que no procedían y las que no tienen información no entran ni
# al numerador ni al denominador. Meterlas diluiría la cifra con casos donde la
# cuadrilla no tenía nada que hacer.
GRUPOS_NUMERADOR: frozenset[str] = frozenset({"ejecutada"})
GRUPOS_DENOMINADOR: frozenset[str] = frozenset({"ejecutada", "no_ejecutable"})


def grupo_de(resultado: str) -> str:
    """Grupo operativo de un resultado del diccionario."""
    return GRUPO_POR_RESULTADO.get(resultado, "sin_dato")


# --------------------------------------------------------------------------
# 3. Etiquetas de columnas sin diccionario
# --------------------------------------------------------------------------

# `clase_servicio` no está en el diccionario de códigos (51 valores, de los
# cuales FM y CA cubren el 94 %). Se muestra el código crudo hasta que
# Acuacar entregue su catálogo.
ETIQUETAS_CLASE_SERVICIO: dict[str, str] = {}

# Esta sí es inequívoca: la columna `ubicacion` solo vale 'U' o 'R', y el mismo
# par aparece rotulado en la hoja «Ciclos de Suspensión» de `Geografia/`.
ETIQUETAS_UBICACION: dict[str, str] = {
    "U": "Urbano",
    "R": "Rural",
}


def etiqueta(tabla: dict[str, str], codigo: object, vacio: str = "SIN DATO") -> str:
    """Traduce un código con la tabla dada; si no está, devuelve el código."""
    if codigo is None:
        return vacio
    texto = str(codigo).strip()
    if not texto or texto.lower() in ("nan", "none"):
        return vacio
    return tabla.get(texto.upper(), texto.upper())


def con_significado(codigo: object, significado: str, vacio: str = "SIN DATO") -> str:
    """'SY' + 'SUSPENSION REALIZADA' -> 'SY · SUSPENSION REALIZADA'.

    Se deja el código delante a propósito: es lo que el operador ve en el
    sistema de origen y lo que permite rastrear la orden hasta la base.
    """
    if codigo is None:
        return vacio
    texto = str(codigo).strip().upper()
    if not texto or texto.lower() in ("nan", "none"):
        return vacio
    if not significado or significado.startswith("("):
        return texto
    return f"{texto} · {significado}"
