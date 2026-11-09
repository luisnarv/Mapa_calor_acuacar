"""Herramientas que el modelo puede invocar (tool calling).

El modelo NO escribe SQL ni calcula: elige una de estas funciones y sus argumentos,
el backend agrega sobre el mismo payload que lee el tablero y le devuelve JSON para
que redacte. Además de datos, una herramienta puede devolver un `FiltroMapa`, que
el frontend aplica al tablero.

Acuacar solo tiene dos estados (Efectiva y Perdida), una brigada (ISES) y un
municipio (Cartagena): por eso no hay herramientas ni filtros por esas dimensiones.
"""

from __future__ import annotations

import calendar
import inspect
import logging
import re
from typing import Any, Sequence

from app.core.texto import norm_dato
from app.schemas.chat import VistaTablero
from app.schemas.metrics import CandidatoBarrio, Efectividad, FiltroMapa
from app.services.metrics_service import (
    CRITERIOS,
    DIMENSIONES,
    BarrioAmbiguo,
    BarrioNoEncontrado,
    FiltroNoResuelto,
    MetricsService,
    _sin_zona,
)

logger = logging.getLogger(__name__)

_BARRIO = {
    "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
    "description": (
        "Barrio a consultar, tal como lo dijo el usuario («Albornoz», «El Pozón»). Varios: "
        "pasa una LISTA y las cifras salen sumadas, con el desglose en `detalle_por_barrio`. "
        "Si en los filtros activos de su pantalla hay uno, pasa esa clave completa tal cual "
        "('CARTAGENA DE INDIAS | ALBORNOZ (C15)'). Un mismo barrio puede estar en varias zonas "
        "(«ALAMEDA LA VICTORIA (C14)» y «(C17)»): si pasas solo el nombre, se suman todas."
    ),
}
_TECNICO = {
    "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
    "description": (
        "Nombre del técnico, completo o parcial y en cualquier orden. Varios: pasa una LISTA y "
        "las cifras salen sumadas. Si el nombre encaja en más de uno vuelven los candidatos: "
        "pregunta cuál. Deja a ese técnico elegido en el tablero."
    ),
}
_MES = {
    "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
    "description": (
        "Periodo: un mes 'YYYY-MM', un año entero 'YYYY' o una lista de meses sueltos "
        "(['2026-08', '2026-09']). Para el histórico completo, 'todo'. Si se omite, se usa el "
        "periodo que el usuario tiene en pantalla."
    ),
}
_ZONA = {
    "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
    "description": (
        "Zona operativa de Cartagena: 'C01', 'C02', ... 'C22' (también vale «zona 11»). Varias: "
        "pasa una LISTA y se filtran todas. "
        "'SIN ZONA' son las órdenes cuyo GPS cae fuera de todo polígono. Úsala solo si el "
        "usuario nombra una."
    ),
}
_CORREGIMIENTO = {
    "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
    "description": (
        "Corregimiento, según el GPS de cada orden (p. ej. «La Boquilla», «Pasacaballos»). "
        "Varios: pasa una LISTA. "
        "«Cabecera municipal» es la zona urbana: todo lo que cae fuera de un corregimiento. "
        "Úsalo solo si el usuario lo nombra; puede combinarse con una zona."
    ),
}
_TIPO_OS = {
    "type": "string",
    "description": (
        "Tipo de orden: «suspensión» (Ordenes de suspensión) o «reconexión» (Reconexión "
        "Impagados). Basta una palabra."
    ),
}
_SUBACCION = {
    "type": "string",
    "description": (
        "Tipo de imposibilidad: el porqué fino que marcó la brigada («medidor empotrado», "
        "«cerrado», «dirección no ubicada», «fuga contador»…). Basta el nombre a medias."
    ),
}
_CAUSA = {
    "type": "string",
    "description": (
        "Causal de no efectividad agrupada: «Oposición del usuario», «Estado del servicio», "
        "«Acceso o seguridad», «Técnica (medidor o red)», «Predio no ubicable», «Rechazada "
        "por movilidad», «Otras causas»."
    ),
}
_TARIFA = {
    "type": "string",
    "description": (
        "Tarifa del suministro, donde vive el estrato: «estrato 3», «comercial», «oficial», "
        "o el código («31»). «Estrato 3» suma sus códigos (31, 32, 36)."
    ),
}
_SIN_PANTALLA = {
    "type": "boolean",
    "description": (
        "Pon true SOLO si el usuario pide expresamente todo Cartagena o ignorar los filtros "
        "que tiene puestos. Por defecto la consulta ya sale del recorte de su pantalla."
    ),
}
_AMBITO = {"barrio": _BARRIO, "zona": _ZONA, "corregimiento": _CORREGIMIENTO, "tecnico": _TECNICO, "tipo_os": _TIPO_OS}


def _herramienta(nombre: str, descripcion: str, propiedades: dict[str, Any], requeridos: list[str] | None = None) -> dict:
    parametros: dict[str, Any] = {"type": "object", "properties": propiedades}
    if requeridos:
        parametros["required"] = requeridos
    return {"type": "function", "function": {"name": nombre, "description": descripcion, "parameters": parametros}}


_ORDEN_DELTA = {
    "type": "string", "enum": ["mas", "menos"],
    "description": "«mas»: primero los que más subieron (o más tienen); «menos»: primero los que más bajaron.",
}

TOOLS: list[dict[str, Any]] = [
    _herramienta(
        "efectividad",
        "Efectividad de un barrio, zona, corregimiento, técnico o del total, con el desglose de efectivas y "
        "perdidas. Úsala para «¿qué efectividad tiene X?». Devuelve `base`, el recorte exacto "
        "sobre el que se calculó, que debes citar.",
        {**_AMBITO, "mes": _MES, "subaccion": _SUBACCION, "tarifa": _TARIFA, "causa": _CAUSA,
         "sin_filtros_de_pantalla": _SIN_PANTALLA},
    ),
    _herramienta(
        "ranking",
        "Ordena técnicos, barrios, zonas, corregimientos, causas, tarifas, subacciones o tipos de orden por "
        "efectividad ajustada (o por pérdidas, volumen…). Úsala para «¿cuáles son los peores "
        "barrios?» o «¿qué técnico rinde mejor?».",
        {
            "dimension": {"type": "string", "enum": list(DIMENSIONES), "description": "Qué se compara."},
            **_AMBITO, "mes": _MES, "subaccion": _SUBACCION, "tarifa": _TARIFA, "causa": _CAUSA,
            "ordenar_por": {
                "type": "string",
                "enum": ["ef_adj", "ef_pct", "ef_adj_pond", "ef_pond", "perdidas", "pct_perdidas", "volumen", "efectivas"],
                "description": (
                    "Criterio de orden; por defecto ef_adj. Para «el mejor» o «los peores» usa "
                    "'ef_adj_pond': pondera por volumen, así un barrio de 10 órdenes todas bien no "
                    "le gana a uno de 200 con 90 %. Usa 'perdidas' cuando pregunten dónde se pierde "
                    "más: son las órdenes no efectivas, en número."
                ),
            },
            "orden": {
                "type": "string", "enum": ["mas", "menos"],
                "description": (
                    "Qué extremo va primero: «mas» deja arriba al que MÁS tiene (más pérdidas, más "
                    "volumen, mayor efectividad), «menos» al que MENOS. Úsalo siempre con perdidas, "
                    "volumen o efectivas."
                ),
            },
            "peores": {"type": "boolean", "description": "Solo con efectividad: true para los de menor valor."},
            "min_ordenes": {"type": "integer", "description": "Mínimo de órdenes para entrar (10 por defecto)."},
            "limite": {
                "type": "integer",
                "description": (
                    "Filas a devolver (10 por defecto). Pasa siempre el número que pidieron («los 2 mejores» → 2, "
                    "«los 5 barrios con más órdenes» → 5): esos quedan elegidos en el tablero. Sin él no se marca nada."
                ),
            },
            "sin_filtros_de_pantalla": _SIN_PANTALLA,
        },
        ["dimension"],
    ),
    _herramienta(
        "causas_no_efectivas",
        "Causas de las órdenes no efectivas (perdidas), de mayor a menor, indicando si cada una "
        "es controlable por la operación.",
        {**_AMBITO, "mes": _MES, "subaccion": _SUBACCION, "tarifa": _TARIFA, "causa": _CAUSA,
         "sin_filtros_de_pantalla": _SIN_PANTALLA},
    ),
    _herramienta(
        "buscar_barrio",
        "Busca barrios por nombre parcial. Úsala cuando el usuario mencione un barrio del que "
        "no estés seguro, antes de pedir métricas.",
        {"texto": {"type": "string"}},
        ["texto"],
    ),
    _herramienta(
        "meses_disponibles",
        "Lista los meses con datos, del más reciente al más antiguo, y hasta qué fecha llegan.",
        {},
    ),
    _herramienta(
        "filtrar_mapa",
        "Aplica un filtro al tablero que el usuario está viendo. No consulta datos. Úsala cuando "
        "pida ver, marcar o resaltar algo, y por iniciativa propia cuando tu respuesta destaque "
        "UN resultado concreto (el peor barrio, el mejor técnico). Para una lista o una "
        "respuesta general no la uses: mover la vista sin que lo pidan molesta.",
        {
            "barrio": _BARRIO, "zona": _ZONA, "corregimiento": _CORREGIMIENTO, "tecnico": _TECNICO,
            "tipo_os": _TIPO_OS,
            "meses": {"type": "array", "items": {"type": "string"}},
            "capas": {
                "type": "array",
                "items": {"type": "string", "enum": ["gps", "calor", "aproximadas", "marcadores", "sin_nic", "poligonos_barrios",
                         "poligonos_municipios", "poligonos_corregimientos", "poligonos_veredas",
                         "poligonos_zonas"]},
                "description": (
                    "Capas que se encienden: «gps» (un punto por orden), «calor» (mapa de calor), "
                    "«aproximadas», «marcadores», «sin_nic» o los polígonos de barrios, municipios, "
                    "corregimientos, veredas o zonas."
                ),
            },
            "capas_apagar": {
                "type": "array",
                "items": {"type": "string", "enum": ["gps", "calor", "aproximadas", "marcadores", "sin_nic", "poligonos_barrios",
                         "poligonos_municipios", "poligonos_corregimientos", "poligonos_veredas",
                         "poligonos_zonas"]},
                "description": "Capas que se apagan («quita el mapa de calor»). Mismos valores que `capas`.",
            },
            "estados": {
                "type": "array",
                "items": {"type": "string", "enum": ["efectiva", "perdida"]},
                "description": (
                    "Qué órdenes se muestran: [«perdida»] deja solo las perdidas, [«efectiva»] solo las "
                    "efectivas, ambas las vuelve a mostrar todas."
                ),
            },
            "minimo_ordenes": {
                "type": "integer",
                "description": "Mínimo de órdenes para que un barrio entre a la cola de riesgo (1 a 500).",
            },
            "umbral_hotspot": {
                "type": "integer",
                "description": "Riesgo desde el cual un barrio se marca crítico (10 a 95; 60 por defecto).",
            },
            "ajustada": {
                "type": "boolean",
                "description": "true: el riesgo se calcula sobre pérdidas controlables; false: sobre todas.",
            },
        },
    ),
    _herramienta(
        "ordenes_de_tecnico",
        "Lista las órdenes de UN técnico, una por una, de la más reciente a la más antigua. "
        "Para totales o porcentajes usa `efectividad`. Si no dijeron cuál técnico, pregunta.",
        {
            "tecnico": _TECNICO, "mes": _MES, "barrio": _BARRIO,
            "estado": {"type": "string", "enum": ["efectiva", "perdida"], "description": "Solo ese estado."},
            "limite": {"type": "integer", "description": "Filas a mostrar (30 por defecto, máximo 100)."},
        },
        ["tecnico"],
    ),
    _herramienta(
        "comparar_periodos",
        "Compara dos o MÁS periodos (agosto contra septiembre, o julio, agosto y septiembre) en "
        "efectividad, pérdidas y volumen, en total o por una dimensión. Úsala para «¿subió o "
        "bajó?», «¿quién mejora o empeora?», «¿por qué cayó?» (dimension «causa»). Sin periodos "
        "compara el último mes con el anterior. La diferencia es último menos primero, en puntos "
        "porcentuales. Deja en el tablero a las entidades que muestra.",
        {
            "dimension": {"type": "string", "enum": ["ninguna", *DIMENSIONES],
                          "description": "Por qué se desglosa. «ninguna» da solo el total de cada periodo."},
            "periodos": {
                "type": "array", "items": {"type": "string"},
                "description": (
                    "Los periodos a comparar, en orden cronológico, tantos como pida el usuario "
                    "(['2026-07', '2026-08', '2026-09'] o ['2025', '2026']). Con esto no uses "
                    "mes_a ni mes_b."
                ),
            },
            "mes_a": {**_MES, "description": "Periodo base (el anterior). Solo para comparar dos."},
            "mes_b": {**_MES, "description": "Periodo nuevo, el que se compara contra el base. Solo para dos."},
            "barrio": _BARRIO, "zona": _ZONA, "corregimiento": _CORREGIMIENTO, "tecnico": _TECNICO,
            "min_ordenes": {"type": "integer", "description": "Mínimo de órdenes en CADA periodo (30 por defecto)."},
            "ordenar_por": {"type": "string", "enum": ["efectividad", "perdidas", "volumen"],
                            "description": "Cuál diferencia ordena la lista. Por defecto efectividad."},
            "orden": _ORDEN_DELTA,
            "limite": {"type": "integer", "description": "Filas a devolver (10 por defecto)."},
            "sin_filtros_de_pantalla": _SIN_PANTALLA,
        },
    ),
    _herramienta(
        "serie_mensual",
        "Efectividad y pérdidas mes por mes, con cuántos meses lleva seguidos en caída. De UNA "
        "entidad (un técnico, barrio, zona, corregimiento o el total) o, con `dimension`, de VARIAS "
        "a la vez, una serie por cada una («la evolución de las zonas C01, C05 y C08»: dimension "
        "«zona» y esas zonas en `zona`). Úsala para «¿cómo ha evolucionado…?». Deja en el tablero "
        "a las entidades que muestra.",
        {"mes": {**_MES, "description": "Meses a incluir. Por defecto todos."},
         "dimension": {"type": "string", "enum": ["ninguna", *DIMENSIONES],
                       "description": "Una serie por cada barrio, zona, corregimiento, técnico… «ninguna»: una sola serie."},
         "min_ordenes": {"type": "integer", "description": "Con dimension: mínimo de órdenes en todo el periodo (1 por defecto)."},
         "limite": {"type": "integer", "description": "Con dimension: cuántas series devolver (10 por defecto, las de más volumen)."},
         "barrio": _BARRIO, "zona": _ZONA, "corregimiento": _CORREGIMIENTO, "tecnico": _TECNICO,
         "sin_filtros_de_pantalla": _SIN_PANTALLA},
    ),
]

NOMBRES_DE_HERRAMIENTAS = frozenset(t["function"]["name"] for t in TOOLS)

# Herramientas que parten de lo que el usuario tiene filtrado en pantalla.
# `filtrar_mapa` no: esa es la que MUEVE los filtros.
_FILTRAN_CON_PANTALLA = frozenset({
    "efectividad", "ranking", "causas_no_efectivas", "ordenes_de_tecnico",
    "comparar_periodos", "serie_mensual",
})
# Pueden dejar algo marcado en el mapa; si no lo hicieron, hay que decirlo.
# Dimensiones cuyos resultados el tablero sabe elegir (un filtro propio por cada una).
_MARCABLES = frozenset({"tecnico", "barrio", "zona", "corregimiento", "tipo_os"})
_SEÑALAN_EN_EL_MAPA = frozenset({"efectividad", "ranking", "causas_no_efectivas", "comparar_periodos", "serie_mensual"})

# Criterios donde un valor alto es malo, no bueno.
MAYOR_ES_PEOR = frozenset({"perdidas", "pct_perdidas"})

# La cédula pegada al nombre del técnico («ANA PEREZ - 111») no le sirve a quien lee.
_CEDULA = re.compile(r"\s*-\s*\d+\s*$")
_ZONA_ESCRITA = re.compile(r"^(?:zona\s*)?c?0*(\d{1,2})$", re.IGNORECASE)


def tools_para_proceso(proceso: str = "scr") -> list[dict[str, Any]]:
    """Acuacar tiene un solo proceso (SCR); se conserva la firma que usa el servicio."""
    return TOOLS


class PeriodoVacio(Exception):
    """El periodo pedido no tiene ni un mes con datos."""

    def __init__(self, pedido: str, disponibles: list[str]) -> None:
        super().__init__(pedido)
        self.pedido = pedido
        self.disponibles = disponibles


TODO_EL_HISTORICO = frozenset({"todo", "historico", "histórico"})


def expandir_meses(mes: Any, disponibles: Sequence[str]) -> list[str] | None:
    """Traduce lo que pidió el modelo a meses concretos del payload.

    Acepta 'YYYY-MM', 'YYYY' (todos los meses de ese año), 'todo' o una lista.

    Returns:
        Los meses pedidos que existen, ordenados; o None si no se pidió periodo.

    Raises:
        PeriodoVacio: si se pidió un periodo y ninguno de sus meses tiene datos.
            Devolver el histórico entero sería peor: la cifra saldría de un
            recorte que nadie pidió y nadie lo notaría.
    """
    if mes is None or mes == "" or mes == []:
        return None

    pedidos = [mes] if isinstance(mes, str) else [str(m) for m in mes]
    conjunto = set(disponibles)
    encontrados: list[str] = []
    for pedido in pedidos:
        pedido = pedido.strip()
        if pedido.lower() in TODO_EL_HISTORICO:
            encontrados.extend(disponibles)
        elif pedido in conjunto:
            encontrados.append(pedido)
        elif len(pedido) == 4 and pedido.isdigit():
            encontrados.extend(m for m in disponibles if m.startswith(f"{pedido}-"))

    if not encontrados:
        raise PeriodoVacio(", ".join(str(m) for m in pedidos), list(disponibles))
    return sorted(set(encontrados))


def etiqueta_periodo(meses: list[str] | None) -> str:
    """Cómo se nombra el periodo en la `base` que lee el modelo."""
    if not meses:
        return "todo el histórico"
    if len(meses) == 1:
        return meses[0]
    anios = {m[:4] for m in meses}
    if len(anios) == 1 and len(meses) > 2:
        return f"{meses[0]} a {meses[-1]}"
    return ", ".join(meses)


class BarrioFueraDeZona(Exception):
    """El barrio existe, pero no en la zona o el corregimiento que piden."""

    def __init__(self, barrio: str, zona: Any, corregimiento: Any, donde_si_esta: list[str]) -> None:
        super().__init__(f"{barrio!r} no está en {zona or corregimiento!r}")
        self.barrio, self.zona, self.corregimiento, self.donde_si_esta = barrio, zona, corregimiento, donde_si_esta


def _zona(texto: "str | list[str] | None") -> "str | list[str] | None":
    """«zona 11», «c11» y «C011» son la zona C11; lo demás se deja como vino.

    Admite una o varias: con una devuelve el texto, con varias la lista sin repetidos.
    """
    if not texto:
        return None
    if not isinstance(texto, str):
        unicas = list(dict.fromkeys(_zona(t) for t in texto if t))
        return unicas[0] if len(unicas) == 1 else (unicas or None)
    coincide = _ZONA_ESCRITA.match(texto.strip())
    return f"C{int(coincide[1]):02d}" if coincide else texto


def _rotulo(valor: "str | list[str]") -> str:
    return valor if isinstance(valor, str) else ", ".join(valor)


def _campos(singular: str, valor: "str | list[str] | None") -> dict:
    """Al filtro del mapa: un valor va en el campo singular, varios en el plural."""
    if not valor:
        return {}
    return {singular: valor} if isinstance(valor, str) else {singular + "s": list(valor)}


class ToolRunner:
    """Ejecuta las herramientas contra el payload y acumula el filtro para el mapa."""

    def __init__(self, metrics: MetricsService, vista: VistaTablero | None = None) -> None:
        self.metrics = metrics
        self.vista = vista
        # Nombres pedidos que el catálogo parte en varios barrios (comunas o zonas), de la
        # consulta en curso. `run` los reporta: sumarlos sin decirlo esconde que el usuario
        # preguntó por uno y la cifra es de dos.
        self._agrupados: dict[str, list[str]] = {}

    # --- Apoyo ----------------------------------------------------------------

    def _avisos(self, *, meses: list[str] | None, vacio: bool = False) -> str:
        """Lo que el modelo tiene que decir aunque nadie se lo pregunte: copia estas notas
        casi literal, así que cada caso que se le escapó se escribe aquí."""
        avisos = []
        if vacio:
            avisos.append("Hay 0 órdenes en este recorte: no existe una efectividad que calcular. "
                          "NO digas «0%»; di que no hay órdenes.")
        fecha_max = self.metrics.datos.fecha_max
        if meses and fecha_max:
            ultimo = fecha_max[:7]
            dias = calendar.monthrange(int(ultimo[:4]), int(ultimo[5:7]))[1]
            if ultimo in meses and int(fecha_max[8:10]) < dias:
                avisos.append(f"{ultimo} está incompleto: los datos llegan solo hasta {fecha_max}. "
                              "No lo compares con un mes completo como si fuera uno entero; avísalo.")
        return "".join(f" OJO: {a}" for a in avisos)

    def _tecnicos(self, tecnico: str | list[str] | None) -> tuple[list[int] | None, list[str]]:
        """Índices y nombres de catálogo de los técnicos pedidos; `None` si no se pidió ninguno."""
        if not tecnico:
            return None, []
        indices = self.metrics.indices_tecnico(tecnico)
        return indices, [self.metrics.datos.tecs[i] for i in indices]

    @staticmethod
    def _rotulo_tecnicos(nombres: list[str]) -> str:
        return f"{'técnicos' if len(nombres) > 1 else 'técnico'} {', '.join(_CEDULA.sub('', n) for n in nombres)}"

    async def _grupo(self, barrio: str) -> list[CandidatoBarrio]:
        """Los barrios que corresponden al texto: uno, o el mismo barrio en varias zonas.

        El ETL le pega la zona al nombre («ALBORNOZ (C15)»), así que un barrio que
        atraviesa dos zonas son dos entradas del catálogo pero un solo sitio para quien
        pregunta: se devuelven juntas y la métrica las suma. Si los candidatos son barrios
        distintos («Centro» y «Centro Comercial»), eso sí hay que preguntar.
        """
        texto = re.sub(r"\s+de\s+cartagena(\s+de\s+indias)?$", "", barrio.strip(), flags=re.IGNORECASE)
        try:
            try:
                return [await self.metrics.resolver_barrio(texto)]
            except BarrioNoEncontrado:
                # El modelo suele agregar de su cosecha la zona («Crespo (C05)») y casi nunca
                # acierta cuál es: sin ella el nombre sí existe. Si la zona estaba bien, no
                # se llega aquí, porque el nombre completo ya coincide.
                sin_zona = _sin_zona(texto)
                if sin_zona == texto:
                    raise
                return [await self.metrics.resolver_barrio(sin_zona)]
        except BarrioAmbiguo as ambiguo:
            # Misma base de nombre = el mismo barrio en varias zonas o comunas.
            if len({norm_dato(_sin_zona(c.barrio)) for c in ambiguo.candidatos}) == 1:
                return ambiguo.candidatos
            raise

    def _con_filtros_de_pantalla(self, nombre: str, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
        """Completa la consulta con los filtros que el usuario tiene puestos y el modelo no pidió.

        Sin esto una pregunta general con la zona C15 puesta se contestaba sobre todo
        Cartagena y la cifra no cuadraba con la pantalla. Reglas:

        * Lo que el modelo pasa explícitamente manda.
        * Entre los sitios gana el más específico: barrio, luego zona.
        * Si la consulta es por una dimensión (ranking por zona), el filtro de esa misma
          dimensión no se aplica: preguntan por todas, no por la que tienen elegida.
        """
        v = self.vista
        if v is None or nombre not in _FILTRAN_CON_PANTALLA:
            return args, {}
        params = inspect.signature(getattr(self, f"_{nombre}")).parameters
        vacio = (None, "", [])
        pidio = lambda k: args.get(k) not in vacio  # noqa: E731
        por = {args.get("dimension")} - {None}
        nuevos, puestos = dict(args), {}

        def poner(param: str, valor: Any, etiqueta: str, dimension: str | None = None) -> None:
            if valor in vacio or param not in params or pidio(param) or dimension in por:
                return
            nuevos[param] = valor
            puestos[etiqueta] = "; ".join(valor) if isinstance(valor, list) else str(valor)

        if not any(pidio(k) for k in ("barrio", "zona", "corregimiento") if k in params):
            barrios = list(v.barrios) or ([v.barrio] if v.barrio else [])
            if barrios and "barrio" not in por:
                poner("barrio", barrios[0] if len(barrios) == 1 else barrios, "barrio" if len(barrios) == 1 else "barrios")
            else:
                # Zona y corregimiento se cruzan en el tablero (cascada): se heredan los dos.
                poner("zona", v.zona, "zona", "zona")
                poner("corregimiento", v.corregimiento, "corregimiento", "corregimiento")
        poner("tipo_os", v.tipo_os, "tipo de orden", "tipo_os")
        if nombre != "ordenes_de_tecnico":
            poner("tecnico", list(v.tecnicos), "técnicos", "tecnico")
        return nuevos, puestos

    async def run(self, nombre: str, args: dict[str, Any]) -> tuple[dict[str, Any], FiltroMapa | None]:
        """Devuelve (resultado para el modelo, filtro para el mapa o None).

        Nunca lanza: los errores se devuelven como datos para que el modelo
        pueda explicarlos o repreguntar.
        """
        # Se valida contra la lista publicada, no contra los atributos: si no, un
        # nombre inventado por el modelo alcanzaría cualquier método privado.
        if nombre not in NOMBRES_DE_HERRAMIENTAS:
            return {"error": f"Herramienta desconocida: {nombre}"}, None
        args = dict(args)
        sin_pantalla = bool(args.pop("sin_filtros_de_pantalla", False))
        self._agrupados = {}
        try:
            aplicados: dict[str, str] = {}
            if not sin_pantalla:
                args, aplicados = self._con_filtros_de_pantalla(nombre, args)
            resultado, filtro = await getattr(self, f"_{nombre}")(**args)
            if aplicados and isinstance(resultado, dict) and "error" not in resultado:
                resultado["filtros_de_pantalla"] = aplicados
                if isinstance(resultado.get("nota"), str):
                    resultado["nota"] += (
                        " Se aplicó lo que el usuario tiene filtrado en su pantalla ("
                        + ", ".join(f"{k}: {v}" for k, v in aplicados.items())
                        + "): di que la cifra es de ese recorte. Si pide todo Cartagena, repite la "
                        "consulta con `sin_filtros_de_pantalla: true`."
                    )
            if self._agrupados and isinstance(resultado, dict) and "error" not in resultado:
                resultado["barrios_incluidos"] = self._agrupados
                if isinstance(resultado.get("nota"), str):
                    resultado["nota"] += (
                        " AVISA al usuario, en la respuesta: lo que pidió corresponde a VARIOS barrios del "
                        "catálogo y la cifra los suma a todos (`barrios_incluidos` dice cuáles). Nómbralos. "
                        "Es normal: un mismo barrio se parte por comunas o zonas."
                    )
            if (filtro is None and nombre in _SEÑALAN_EN_EL_MAPA and isinstance(resultado, dict)
                    and isinstance(resultado.get("nota"), str)):
                # Sin esto el modelo decía «ya te marqué el estrato 6» cuando el mapa no se movió.
                resultado["nota"] += " El mapa no se movió con esta consulta: no digas que lo marcaste."
            return resultado, filtro
        except BarrioNoEncontrado as exc:
            return {
                "error": "barrio_no_encontrado",
                "texto_buscado": exc.texto,
                "sugerencia": "Pide al usuario que confirme el nombre del barrio.",
            }, None
        except BarrioFueraDeZona as exc:
            return {
                "error": "barrio_fuera_de_zona",
                "barrio": exc.barrio,
                "zona_pedida": exc.zona or exc.corregimiento,
                "aparece_en": exc.donde_si_esta,
                "sugerencia": (
                    "Ese barrio no registra órdenes en esa zona o corregimiento. Dilo y ofrece las zonas donde "
                    "sí aparece (`aparece_en`). No contestes con la cifra de otra zona."
                ),
            }, None
        except PeriodoVacio as exc:
            return {
                "error": "periodo_sin_datos",
                "periodo_pedido": exc.pedido,
                "meses_con_datos": exc.disponibles,
                "sugerencia": (
                    "No hay órdenes en ese periodo. Dilo tal cual —no es 0% de efectividad, es "
                    "que no hay datos— y ofrece los meses que sí hay."
                ),
            }, None
        except BarrioAmbiguo as exc:
            return {
                "error": "barrio_ambiguo",
                "texto_buscado": exc.texto,
                "candidatos": [c.model_dump() for c in exc.candidatos],
                "sugerencia": "Pregunta al usuario cuál de estos barrios quiso decir.",
            }, None
        except FiltroNoResuelto as exc:
            return {
                "error": "filtro_no_reconocido",
                "campo": exc.campo,
                "valor_pedido": exc.valor,
                "valores_validos": exc.catalogo,
                "sugerencia": (
                    f"«{exc.valor}» no es un {exc.campo} de este sistema: no coincide con ninguno de "
                    "`valores_validos`, o coincide con más de uno. NO es que falten datos ahí: el "
                    "filtro nunca se aplicó, así que cualquier cifra que dieras sería de otro "
                    "recorte. Elige uno de `valores_validos` y repite, o pregúntale al usuario."
                ),
            }, None
        except (TypeError, ValueError) as exc:
            # Argumentos que el modelo inventó: parámetros que no existen (TypeError) o
            # valores fuera del enum (ValueError). Vuelven como dato para que reintente.
            logger.warning("Argumentos inválidos para %s: %s", nombre, exc)
            return {"error": f"Argumentos inválidos para {nombre}: {exc}"}, None

    def _corr(self, texto: "str | list[str] | None") -> "str | list[str] | None":
        """Nombre canónico del corregimiento (tolera tildes, mayúsculas y nombre a medias).

        Admite uno o varios. Lanza FiltroNoResuelto si alguno no existe, o si el payload es
        anterior a la columna.
        """
        if not texto:
            return None
        p = self.metrics.datos
        nombres = [texto] if isinstance(texto, str) else list(texto)
        canonicos = []
        for nombre in nombres:
            i = self.metrics._indice(p.corrs, nombre)
            if i is None:
                i = self.metrics._indice_parcial(p.corrs, nombre)
            if i is None:
                raise FiltroNoResuelto("corregimiento", nombre, p.corrs)
            canonicos.append(p.corrs[i])
        canonicos = list(dict.fromkeys(canonicos))
        return canonicos[0] if len(canonicos) == 1 else canonicos

    async def _claves_de(self, nombre: str, zona: Any = None, corregimiento: Any = None) -> list[str]:
        """Las claves del barrio, restringidas a la zona o el corregimiento que pidan.

        Un barrio atraviesa varias zonas y cada una es una entrada del catálogo
        («VILLA ESTRELLA (C11)», «(C07)»…). Sin esta restricción, «Villa Estrella en la zona
        C11» devolvía las cuatro sumadas. Si el barrio no aparece en esa zona, lanza
        BarrioFueraDeZona con las zonas donde sí está.
        """
        claves = [c.bkey for c in await self._grupo(nombre)]
        if not (zona or corregimiento):
            return claves
        p = self.metrics.datos
        pos = {b: i for i, b in enumerate(p.barrios)}
        zs = self.metrics._indices(p.zonas, zona)
        if zona and zs is None:
            raise FiltroNoResuelto("zona", _rotulo(zona), p.zonas)
        cs = self.metrics._indices(p.corrs, corregimiento)
        if corregimiento and cs is None:
            raise FiltroNoResuelto("corregimiento", _rotulo(corregimiento), p.corrs)
        mantener = [
            k for k in claves
            if (zs is None or p.b_zona[pos[k]] in zs) and (cs is None or p.b_corr[pos[k]] in cs)
        ]
        if not mantener:
            raise BarrioFueraDeZona(nombre, zona, corregimiento, [k.partition(" | ")[2] for k in claves])
        return mantener

    async def _recorte(
        self,
        barrio: str | list[str] | None,
        mes: Any,
        zona: str | None = None,
        tipo_os: str | None = None,
        corregimiento: str | None = None,
    ) -> tuple[list[str] | None, list[str] | None, str, FiltroMapa]:
        """Traduce los argumentos a un recorte concreto, su descripción y su filtro del mapa.

        La descripción viaja de vuelta al modelo en cada respuesta: es lo que le
        permite decir sobre qué calculó la cifra en vez de dar por hecho que le
        hicieron caso.
        """
        disponibles = await self.metrics.meses_disponibles()
        meses = expandir_meses(mes, disponibles)
        if meses is None and self.vista:
            # Sin periodo pedido se hereda el de su pantalla: contestar el histórico completo
            # mientras él mira un mes deja dos cifras que no cuadran. Para todo el histórico
            # hay que pedirlo con `mes: "todo"`.
            en_pantalla = sorted(m for m in self.vista.meses if m in disponibles)
            meses = en_pantalla or None

        zona = _zona(zona)
        corregimiento = self._corr(corregimiento)
        bkeys = None
        nombres = [barrio] if isinstance(barrio, str) else [n for n in (barrio or []) if n]
        if nombres:
            claves: list[str] = []
            for nombre in nombres:
                grupo = await self._claves_de(nombre, zona, corregimiento)
                if len(grupo) > 1:
                    self._agrupados[nombre] = [k.partition(" | ")[2] for k in grupo]
                claves += grupo
            bkeys = list(dict.fromkeys(claves))

        if bkeys and len(bkeys) == 1:
            donde = bkeys[0]
        elif bkeys and len(nombres) > 1:
            donde = f"{len(bkeys)} barrios ({', '.join(nombres)})"
        elif bkeys:
            donde = f"{len(bkeys)} zonas del barrio {nombres[0]}"
        else:
            sitio = [f"zona {_rotulo(zona)}" if zona else None,
                     f"corregimiento {_rotulo(corregimiento)}" if corregimiento else None]
            donde = " · ".join(s for s in sitio if s) or "todo Cartagena"

        partes = [donde, etiqueta_periodo(meses)]
        tipo_canonico = None
        if tipo_os:
            p = self.metrics.datos
            i = self.metrics._indice_parcial(p.tipos, tipo_os)
            if i is None:
                raise FiltroNoResuelto("tipo_os", tipo_os, p.tipos)
            tipo_canonico = p.tipos[i]
            partes.append(tipo_canonico)

        filtro = FiltroMapa(
            barrio=bkeys[0] if bkeys and len(bkeys) == 1 else None,
            barrios=bkeys if bkeys and len(bkeys) > 1 else None,
            **({} if bkeys else {**_campos("zona", zona), **_campos("corregimiento", corregimiento)}),
            tipo_os=tipo_canonico,
            meses=meses,
        )
        # Para el cálculo, `meses=None` es todo el histórico; pero el tablero lo lee como
        # «no toques el periodo» y se queda en el mes que tuviera puesto: la respuesta habla
        # de un periodo y el mapa enseña otro. Solo si el filtro recorta algo más: sobre uno
        # vacío se emitiría y eso le mueve la vista al usuario sin motivo.
        if filtro.meses is None and filtro.model_dump(exclude_none=True):
            filtro.meses = sorted(disponibles)
        return bkeys, meses, " · ".join(partes), filtro

    @staticmethod
    def _con_detalle(base: str, subaccion: str | None, tarifa: str | None, causa: str | None) -> str:
        """Agrega a la `base` los filtros que el tablero no tiene, para que la cifra diga de qué recorte es."""
        extras = [subaccion, tarifa, f"causa {causa}" if causa else None]
        return base + "".join(f" · {e}" for e in extras if e)

    # --- Herramientas ---------------------------------------------------------

    async def _efectividad(
        self,
        barrio: str | list[str] | None = None,
        mes: Any = None,
        tipo_os: str | None = None,
        subaccion: str | None = None,
        tarifa: str | None = None,
        zona: str | None = None,
        corregimiento: str | None = None,
        causa: str | None = None,
        tecnico: str | list[str] | None = None,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        bkeys, meses, base, filtro = await self._recorte(barrio, mes, zona, tipo_os, corregimiento)
        tecnicos, nombres_tec = self._tecnicos(tecnico)
        if nombres_tec:
            base += f" · {self._rotulo_tecnicos(nombres_tec)}"
        base = self._con_detalle(base, subaccion, tarifa, causa)
        # El tablero no filtra por subacción, tarifa ni causa: moverlo con solo el sitio
        # enseñaría un recorte más ancho que la respuesta.
        if subaccion or tarifa or causa:
            filtro = None
        if nombres_tec:
            filtro = (filtro or FiltroMapa()).model_copy(update={"tecnicos": nombres_tec})
        datos = await self.metrics.efectividad(
            bkeys=bkeys, zona=None if bkeys else _zona(zona),
            corregimiento=None if bkeys else self._corr(corregimiento), meses=meses, tipo_os=tipo_os,
            subaccion=subaccion, tarifa=tarifa, causa=causa, tecnicos=tecnicos, etiqueta=base,
        )

        salida: dict[str, Any] = {
            "base": base,
            "datos_hasta": self.metrics.datos.fecha_max,
            "metricas": datos.model_dump(),
            # El modelo copia esta nota casi literal, así que aquí van ya los nombres que debe
            # usar: escribir «ef_pct» le hacía soltar el nombre del campo en la respuesta.
            "nota": (
                "Da SIEMPRE las dos cifras, aunque solo te pidan «la efectividad»: `ef_pct` es "
                "«efectividad» y `ef_adj` «efectividad ajustada». No escribas los nombres de los "
                "campos ni la palabra «cruda». Solo existen efectivas y perdidas (`pe`): no hay "
                "fallidas. Di sobre qué base están calculadas."
            ),
        }
        salida["nota"] += self._avisos(meses=meses, vacio=datos.tot == 0)
        if tecnicos and len(tecnicos) > 1:
            # Comparar es dar las cifras de cada uno: sumados juntos no se distingue quién rinde más.
            detalle = await self.metrics.ranking(
                dimension="tecnico", bkeys=bkeys, zona=None if bkeys else _zona(zona),
                corregimiento=None if bkeys else self._corr(corregimiento), meses=meses,
                tipo_os=tipo_os, tecnicos=tecnicos, min_ordenes=0, limite=len(tecnicos),
            )
            salida["detalle_por_tecnico"] = [f.model_dump() for f in detalle]
            salida["nota_agrupacion_tecnicos"] = (
                f"`metricas` suma {len(tecnicos)} técnicos juntos. Si piden compararlos, usa "
                "`detalle_por_tecnico`: una fila por cada uno."
            )
        nombres = [barrio] if isinstance(barrio, str) else [n for n in (barrio or []) if n]
        if bkeys and len(nombres) == 1 and len(bkeys) > 1:
            # UN barrio que los datos parten en varias zonas: `metricas` ya es el barrio completo, y
            # se da el desglose por zona para que el usuario vea dónde se concentra.
            detalle = []
            for clave in bkeys:
                fila = await self.metrics.efectividad(
                    bkeys=[clave], meses=meses, tipo_os=tipo_os, subaccion=subaccion, tarifa=tarifa,
                    causa=causa, tecnicos=tecnicos, etiqueta=clave.partition(" | ")[2])
                detalle.append(fila.model_dump())
            detalle.sort(key=lambda d: -d["tot"])
            salida["detalle_por_zona"] = detalle
            salida["nota_agrupacion"] = (
                f"El barrio {nombres[0]} aparece en {len(bkeys)} zonas en los datos (cada orden toma la zona de "
                "su GPS): es UN solo barrio y `metricas` ya los suma. Da ese total y, si es útil, el desglose de "
                "`detalle_por_zona`. Si el usuario quiere una zona concreta, vuelve a llamar con `zona`."
            )
        elif bkeys and len(bkeys) > 1:
            # Una fila por cada barrio que PIDIERON, no por cada entrada del catálogo: «Olaya
            # Herrera» son dos (COM 5 y COM 6) y comparar solo una daría la mitad de sus órdenes.
            detalle = []
            for nombre in nombres:
                claves = await self._claves_de(nombre, _zona(zona), self._corr(corregimiento))
                fila = await self.metrics.efectividad(
                    bkeys=claves, meses=meses, tipo_os=tipo_os, subaccion=subaccion, tarifa=tarifa,
                    causa=causa, tecnicos=tecnicos, etiqueta=nombre)
                detalle.append(fila.model_dump())
            salida["detalle_por_barrio"] = detalle
            salida["nota_agrupacion"] = (
                f"`metricas` suma {len(nombres)} barrios juntos. Para compararlos usa `detalle_por_barrio`: "
                "una fila por cada barrio pedido, con todas sus zonas o comunas ya sumadas. Dilo, y ofrece el desglose."
            )
        return salida, filtro

    async def _ranking(
        self,
        dimension: str,
        barrio: str | list[str] | None = None,
        mes: Any = None,
        tipo_os: str | None = None,
        peores: bool | None = None,
        orden: str | None = None,
        min_ordenes: int = 10,
        ordenar_por: str = "ef_adj",
        subaccion: str | None = None,
        tarifa: str | None = None,
        zona: str | None = None,
        corregimiento: str | None = None,
        causa: str | None = None,
        tecnico: str | list[str] | None = None,
        limite: int | None = None,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        bkeys, meses, base, filtro = await self._recorte(barrio, mes, zona, tipo_os, corregimiento)
        tecnicos, nombres_tec = self._tecnicos(tecnico)
        if nombres_tec:
            base += f" · {self._rotulo_tecnicos(nombres_tec)}"
        filtra_aparte = bool(subaccion or tarifa or causa)  # el tablero no filtra por estas
        if filtra_aparte:
            filtro = None
        if nombres_tec:
            filtro = (filtro or FiltroMapa()).model_copy(update={"tecnicos": nombres_tec})

        # `orden` manda: «mas» es el que más tiene, sin importar el criterio. Sin él, con
        # efectividad `peores` pide los de menor valor; y con pérdidas el peor es el que más
        # tiene, así que omitir `peores` deja primero a los que MÁS pierden.
        if orden:
            ascendente = orden == "menos"
        elif ordenar_por in MAYOR_ES_PEOR:
            ascendente = peores is False
        else:
            ascendente = bool(peores)

        filas = await self.metrics.ranking(
            dimension=dimension, bkeys=bkeys, zona=None if bkeys else _zona(zona),
            corregimiento=None if bkeys else self._corr(corregimiento), meses=meses,
            tipo_os=tipo_os, min_ordenes=min_ordenes, ascendente=ascendente, ordenar_por=ordenar_por,
            subaccion=subaccion, tarifa=tarifa, causa=causa, tecnicos=tecnicos,
            **({"limite": max(1, min(int(limite), 50))} if limite else {}),
        )

        nota = (
            "OBLIGATORIO: para CADA entrada muestra las dos efectividades (ef_pct y ef_adj) y el "
            "total de órdenes. Esto aplica SIEMPRE, aunque la pregunta sea sobre pérdidas o "
            "volumen. Solo existen efectivas y perdidas: no hay fallidas."
        )
        if dimension == "tecnico":
            nota += (" Si estás recomendando un técnico, aclara que es por desempeño histórico, "
                     "sin datos de carga ni disponibilidad actual.")
        salida: dict[str, Any] = {
            "base": base,
            "datos_hasta": self.metrics.datos.fecha_max,
            "dimension": dimension,
            "orden": "de menos a más" if ascendente else "de más a menos",
            "total_en_recorte": filas.total,
            "criterio": ordenar_por,
            "min_ordenes": min_ordenes,
            "filas": [f.model_dump() for f in filas],
            "nota": nota + self._avisos(meses=meses),
        }
        if dimension == "zona" and any(f.nombre == "SIN ZONA" for f in filas):
            salida["nota"] += (" `SIN ZONA` no es una zona operativa: son órdenes cuyo GPS cae fuera de todo "
                               "polígono. Menciónala aparte; no la cuentes como una de las zonas del ranking.")
        if dimension == "corregimiento":
            salida["nota"] += (" «Cabecera municipal» no es un corregimiento: es la zona urbana (GPS fuera de "
                               "todo polígono de corregimiento). Preséntala como tal.")
        if not filas:
            salida["nota"] = f"Sin resultados en {base} con el mínimo de {min_ordenes} órdenes pedido."
        elif (dimension in _MARCABLES and limite and not filtra_aparte
              and not (dimension == "tecnico" and nombres_tec)):
            # Lo que se nombra en la respuesta («los 2 mejores técnicos», «las 3 peores zonas»)
            # queda elegido en el tablero. Sin `limite` es un listado general: no se marca nada.
            filtro = self._marcar(filtro, dimension, [f.nombre for f in filas])
            salida["marcado_en_mapa"] = True
        elif filas and dimension in _MARCABLES and not filtra_aparte:
            # Sin `limite` no se marca nada: el modelo no puede afirmar que lo hizo. Si el usuario
            # pidió verlos en el mapa, que repita con `limite` (el número que pidió).
            salida["marcado_en_mapa"] = False
            salida["nota"] += (
                " NO se marcó nada en el mapa. Si el usuario pidió marcar, ver o resaltar estos, vuelve a "
                "llamar esta herramienta con `limite` = cuántos pidió; no digas que los marcaste sin eso."
            )
        return salida, filtro

    async def _causas_no_efectivas(
        self,
        barrio: str | list[str] | None = None,
        mes: Any = None,
        tipo_os: str | None = None,
        zona: str | None = None,
        corregimiento: str | None = None,
        subaccion: str | None = None,
        tarifa: str | None = None,
        causa: str | None = None,
        tecnico: str | list[str] | None = None,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        bkeys, meses, base, filtro = await self._recorte(barrio, mes, zona, tipo_os, corregimiento)
        tecnicos, nombres_tec = self._tecnicos(tecnico)
        if nombres_tec:
            base += f" · {self._rotulo_tecnicos(nombres_tec)}"
        base = self._con_detalle(base, subaccion, tarifa, causa)
        if subaccion or tarifa or causa:
            filtro = None
        if nombres_tec:
            filtro = (filtro or FiltroMapa()).model_copy(update={"tecnicos": nombres_tec})
        filas = await self.metrics.causas(
            bkeys=bkeys, zona=None if bkeys else _zona(zona),
            corregimiento=None if bkeys else self._corr(corregimiento), meses=meses, tipo_os=tipo_os,
            subaccion=subaccion, tarifa=tarifa, causa=causa, tecnicos=tecnicos,
        )
        return {
            "base": base,
            "datos_hasta": self.metrics.datos.fecha_max,
            "causas": [f.model_dump() for f in filas],
            "nota": ("`pct` es el porcentaje sobre las órdenes perdidas del recorte. «Controlable» "
                     "dice si la causa depende de la brigada: Oposición del usuario y Estado del "
                     "servicio no cuentan contra ella en la efectividad ajustada."
                     + self._avisos(meses=meses, vacio=not filas)),
        }, filtro

    async def _buscar_barrio(self, texto: str) -> tuple[dict[str, Any], None]:
        candidatos = await self.metrics.buscar_barrios(texto)
        mostrados = candidatos[:12]
        salida: dict[str, Any] = {
            "total_encontrados": len(candidatos),
            "candidatos": [c.model_dump() for c in mostrados],
        }
        if len(mostrados) < len(candidatos):
            salida["nota"] = (f"Hay {len(candidatos)} en total; se muestran los {len(mostrados)} "
                              "de mayor volumen. Dilo si le presentas la lista.")
        return salida, None

    async def _meses_disponibles(self) -> tuple[dict[str, Any], None]:
        return {"meses": await self.metrics.meses_disponibles(), "datos_hasta": self.metrics.datos.fecha_max}, None

    async def _filtrar_mapa(self, **kwargs: Any) -> tuple[dict[str, Any], FiltroMapa | None]:
        if kwargs.get("tecnico"):
            kwargs["tecnicos"] = self._tecnicos(kwargs["tecnico"])[1]
        for campo, valor in (("zona", _zona(kwargs.pop("zona", None))),
                             ("corregimiento", self._corr(kwargs.pop("corregimiento", None)))):
            kwargs.update(_campos(campo, valor))
        barrio = kwargs.get("barrio")
        nombres = [barrio] if isinstance(barrio, str) else [n for n in (barrio or []) if n]
        if nombres:
            claves: list[str] = []
            for nombre in nombres:
                claves += await self._claves_de(
                    nombre, kwargs.get("zona") or kwargs.get("zonas"),
                    kwargs.get("corregimiento") or kwargs.get("corregimientos"))
            claves = list(dict.fromkeys(claves))
            kwargs["barrio"] = claves[0] if len(claves) == 1 else None
            kwargs["barrios"] = claves if len(claves) > 1 else None
        if kwargs.get("tipo_os"):
            p = self.metrics.datos
            i = self.metrics._indice_parcial(p.tipos, kwargs["tipo_os"])
            if i is None:
                raise FiltroNoResuelto("tipo_os", kwargs["tipo_os"], p.tipos)
            kwargs["tipo_os"] = p.tipos[i]

        filtro = FiltroMapa(**{k: v for k, v in kwargs.items() if k in FiltroMapa.model_fields})
        aplicado = filtro.model_dump(exclude_none=True)
        if not aplicado:
            # Un filtro vacío no filtra nada, pero al llegar al tablero igual le cambiaba la
            # pestaña al usuario.
            return {
                "error": "filtro_vacio",
                "sugerencia": ("No mandaste ningún campo, así que no hay nada que filtrar. Llama a "
                               "filtrar_mapa solo con un barrio, zona, corregimiento, técnico, tipo de orden o meses concretos."),
            }, None
        return {"aplicado": aplicado}, filtro

    async def _ordenes_de_tecnico(
        self,
        tecnico: str | list[str] | None = None,
        mes: Any = None,
        barrio: str | list[str] | None = None,
        estado: str | None = None,
        limite: int = 30,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        if not tecnico:
            return {"error": "falta_tecnico", "sugerencia": (
                "No dijeron de cuál. Pregunta el nombre; no elijas uno ni listes varios.")}, None
        indices, nombres = self._tecnicos(tecnico)
        bkeys, meses, base, filtro = await self._recorte(barrio, mes)
        base = f"{self._rotulo_tecnicos(nombres)} · {base}"
        limite = max(1, min(int(limite), 100))
        datos = self.metrics.visitas_tecnico(
            indices or [], bkeys=bkeys, meses=meses, estado=estado, limite=limite)
        # Listar órdenes pide verlas: se enciende la capa de puntos GPS.
        filtro = filtro.model_copy(update={"tecnicos": nombres, "capas": ["gps"]})
        nota = (
            f"Son {datos['total']} en total y se muestran {len(datos['filas'])}: di el total y que la "
            "lista es parcial si hay más. `por_estado` es de TODAS, no solo de las mostradas. ESCRIBE "
            "las filas en tu respuesta (fecha, barrio, estado, causa): el usuario no ve esta lista en "
            "ninguna otra parte."
        )
        return {"base": base, **datos, "nota": nota + self._avisos(meses=meses, vacio=not datos["total"])}, filtro

    # --- Análisis mensual -----------------------------------------------------

    @staticmethod
    def _metrica(fila: Efectividad) -> float:
        return fila.ef_adj

    def _marcar(self, filtro: FiltroMapa | None, dimension: str, nombres: list[str]) -> FiltroMapa | None:
        """Deja elegidas en el tablero las entidades que la respuesta nombra.

        Hasta 10; con más, o sin ninguna, no se marca nada. El tipo de orden solo se elige si
        es uno (con dos sería no filtrar). Las demás dimensiones (causa, tarifa, subacción) no
        tienen filtro en el tablero.
        """
        if dimension not in _MARCABLES or not nombres or len(nombres) > 10:
            return filtro
        base = filtro or FiltroMapa()
        if dimension == "tecnico":
            return base.model_copy(update={"tecnicos": nombres})
        if dimension == "barrio":
            # Con su clave completa, y sin zona ni corregimiento que los contradigan.
            return base.model_copy(update={
                "barrio": nombres[0] if len(nombres) == 1 else None,
                "barrios": nombres if len(nombres) > 1 else None,
                "zona": None, "zonas": None, "corregimiento": None, "corregimientos": None,
            })
        if dimension in ("zona", "corregimiento"):
            return base.model_copy(update={
                "zona": None, "zonas": None, "corregimiento": None, "corregimientos": None,
                **_campos(dimension, nombres[0] if len(nombres) == 1 else nombres),
            })
        return base.model_copy(update={"tipo_os": nombres[0]}) if len(nombres) == 1 else filtro

    @staticmethod
    def _resumen_serie(serie: list[dict[str, Any]]) -> dict[str, Any]:
        """Caídas seguidas, mejor y peor mes y variación de una serie mensual."""
        caidas = 0
        for anterior, actual in zip(reversed(serie[:-1]), reversed(serie[1:])):
            if actual["efectividad"] >= anterior["efectividad"]:
                break
            caidas += 1
        return {
            "meses_seguidos_en_caida": caidas,
            "mejor_mes": max(serie, key=lambda f: f["efectividad"])["mes"],
            "peor_mes": min(serie, key=lambda f: f["efectividad"])["mes"],
            "variacion_primero_a_ultimo_pp": round(serie[-1]["efectividad"] - serie[0]["efectividad"], 1),
        }

    async def _comparar_periodos(
        self,
        dimension: str = "ninguna",
        mes_a: Any = None,
        mes_b: Any = None,
        periodos: list[str] | None = None,
        barrio: str | list[str] | None = None,
        zona: str | list[str] | None = None,
        corregimiento: str | list[str] | None = None,
        tecnico: str | list[str] | None = None,
        min_ordenes: int = 30,
        ordenar_por: str = "efectividad",
        orden: str = "menos",
        limite: int = 10,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        disponibles = await self.metrics.meses_disponibles()  # del más reciente al más antiguo
        if periodos:
            pedidos = [periodos] if isinstance(periodos, str) else list(periodos)
            lista = [expandir_meses(p, disponibles) for p in pedidos]
        else:
            lista = [
                expandir_meses(mes_a or (disponibles[1] if len(disponibles) > 1 else None), disponibles),
                expandir_meses(mes_b or disponibles[0], disponibles),
            ]
        if len(lista) < 2 or not all(lista):
            return {"error": "faltan_periodos", "sugerencia": "Pide al menos dos periodos a comparar."}, None
        etiquetas = [etiqueta_periodo(m) for m in lista]
        union = sorted({m for p in lista for m in p})

        bkeys, _, _, filtro = await self._recorte(barrio, union, zona, None, corregimiento)
        tecnicos, nombres_tec = self._tecnicos(tecnico)
        ambito = dict(bkeys=bkeys, zona=None if bkeys else _zona(zona),
                      corregimiento=None if bkeys else self._corr(corregimiento), tecnicos=tecnicos)

        async def por_periodo(meses: list[str]) -> dict[str, Efectividad]:
            filas = await self.metrics.ranking(
                dimension=dimension, meses=meses, min_ordenes=0, limite=10**6, ordenar_por="volumen", **ambito)
            return {f.nombre: f for f in filas}

        def resumen(fs: list[Efectividad], nombre: str) -> dict[str, Any]:
            """Primero contra último (con dos periodos, A contra B); con más, también cada uno."""
            a, b = fs[0], fs[-1]
            fila: dict[str, Any] = {
                "nombre": nombre, "tot_a": a.tot, "tot_b": b.tot, "delta_tot": b.tot - a.tot,
                "efectividad_a": round(self._metrica(a), 1), "efectividad_b": round(self._metrica(b), 1),
                "delta_efectividad_pp": round(self._metrica(b) - self._metrica(a), 1),
                "perdidas_a": a.pe, "perdidas_b": b.pe, "delta_perdidas": b.pe - a.pe,
            }
            if len(fs) > 2:
                fila["periodos"] = [
                    {"periodo": e, "tot": f.tot, "efectividad": round(self._metrica(f), 1), "perdidas": f.pe}
                    for e, f in zip(etiquetas, fs)
                ]
                fila["cambios_consecutivos_pp"] = [
                    round(self._metrica(y) - self._metrica(x), 1) for x, y in zip(fs, fs[1:])
                ]
            return fila

        totales = [await self.metrics.efectividad(meses=m, **ambito) for m in lista]
        salida: dict[str, Any] = {"periodos": etiquetas, "total": resumen(totales, "TOTAL")}
        if len(lista) == 2:
            salida["periodo_a"], salida["periodo_b"] = etiquetas
        if dimension != "ninguna":
            tablas = [await por_periodo(m) for m in lista]
            vacio = lambda n: Efectividad(nombre=n, tot=0, ef=0, pe=0, noctrl=0, ef_pct=0.0, ef_adj=0.0)  # noqa: E731
            # Con efectividad solo vale quien tiene muestra en TODOS los periodos; con volumen,
            # pérdidas o causas, que desaparezca en alguno es justo lo que interesa.
            solo_volumen = ordenar_por != "efectividad" or dimension == "causa"
            filas = []
            for nombre in dict.fromkeys(n for t in tablas for n in t):
                fs = [t.get(nombre) or vacio(nombre) for t in tablas]
                if (max(f.tot for f in fs) < 1) if solo_volumen else (min(f.tot for f in fs) < min_ordenes):
                    continue
                filas.append(resumen(fs, nombre))
            clave = {"efectividad": "delta_efectividad_pp", "perdidas": "delta_perdidas", "volumen": "delta_tot"}[ordenar_por]
            filas.sort(key=lambda r: r[clave], reverse=orden == "mas")
            salida["filas"] = filas[: max(1, min(int(limite), 50))]
            salida["total_filas"] = len(filas)
        salida["nota"] = (
            "`delta_efectividad_pp` es la efectividad ajustada del último periodo menos la del primero, en "
            "puntos porcentuales; positivo es que mejoró. Con más de dos periodos, `periodos` da cada uno y "
            "`cambios_consecutivos_pp` el cambio entre uno y el siguiente; `*_a` es el primero y `*_b` el último. "
            "Las pérdidas y el volumen van en cantidades. Di siempre los periodos." + self._avisos(meses=union)
        )
        contexto = [self._rotulo_tecnicos(nombres_tec)] if nombres_tec else []
        sitio = [f"zona {_rotulo(_zona(zona))}" if zona else None,
                 f"corregimiento {_rotulo(self._corr(corregimiento))}" if corregimiento else None]
        salida["base"] = " · ".join([*contexto, *(s for s in sitio if s)] or [*contexto, "todo Cartagena"])
        salida["datos_hasta"] = self.metrics.datos.fecha_max

        # El mapa queda en lo comparado: el sitio pedido, los técnicos y, desglosado, las
        # entidades que la respuesta muestra, con los meses de la comparación.
        if nombres_tec:
            filtro = filtro.model_copy(update={"tecnicos": nombres_tec})
        if dimension != "ninguna" and not (dimension == "tecnico" and nombres_tec):
            filtro = self._marcar(filtro, dimension, [f["nombre"] for f in salida.get("filas", [])])
        return salida, filtro

    async def _serie_mensual(
        self,
        mes: Any = "todo",
        dimension: str = "ninguna",
        barrio: str | list[str] | None = None,
        zona: str | list[str] | None = None,
        corregimiento: str | list[str] | None = None,
        tecnico: str | list[str] | None = None,
        min_ordenes: int = 1,
        limite: int = 10,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        disponibles = sorted(await self.metrics.meses_disponibles())
        meses = sorted(expandir_meses(mes or "todo", disponibles) or disponibles)
        if dimension != "ninguna":
            if dimension not in DIMENSIONES:
                raise ValueError(f"Dimensión no soportada: {dimension}")
            return await self._serie_por_dimension(
                dimension, meses, barrio, zona, corregimiento, tecnico, min_ordenes, limite)

        filas, filtro, base = [], None, ""
        for m in meses:
            resultado, filtro = await self._efectividad(
                barrio=barrio, mes=m, zona=zona, corregimiento=corregimiento, tecnico=tecnico)
            base = resultado["base"].rsplit(" · ", 1)[0] if " · " in resultado["base"] else resultado["base"]
            d = resultado["metricas"]
            if d["tot"]:
                filas.append({"mes": m, "tot": d["tot"], "efectividad": d["ef_adj"], "perdidas": d["pe"],
                              "pct_perdidas": round(100 * d["pe"] / d["tot"], 1)})
        if not filas:
            return {"error": "sin_datos", "sugerencia": "Ese recorte no tiene órdenes en ningún mes."}, None
        salida = {
            "base": base, "serie": filas, **self._resumen_serie(filas),
            "datos_hasta": self.metrics.datos.fecha_max,
            "nota": ("`efectividad` es la efectividad ajustada de cada mes. `meses_seguidos_en_caida` "
                     "cuenta hacia atrás desde el último mes." + self._avisos(meses=[filas[-1]["mes"]])),
        }
        if filtro and filtro.model_dump(exclude_none=True, exclude={"meses"}):
            return salida, filtro.model_copy(update={"meses": meses})
        return salida, None

    async def _serie_por_dimension(
        self, dimension: str, meses: list[str], barrio: Any, zona: Any, corregimiento: Any,
        tecnico: Any, min_ordenes: int, limite: int,
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        """Una serie mensual por cada barrio, zona, corregimiento, técnico… del recorte."""
        bkeys, _, base, filtro = await self._recorte(barrio, meses, zona, None, corregimiento)
        tecnicos, nombres_tec = self._tecnicos(tecnico)
        if nombres_tec:
            base += f" · {self._rotulo_tecnicos(nombres_tec)}"
        ambito = dict(bkeys=bkeys, zona=None if bkeys else _zona(zona),
                      corregimiento=None if bkeys else self._corr(corregimiento), tecnicos=tecnicos)

        por_mes: list[dict[str, Efectividad]] = []
        for m in meses:
            filas = await self.metrics.ranking(
                dimension=dimension, meses=[m], min_ordenes=0, limite=10**6, ordenar_por="volumen", **ambito)
            por_mes.append({f.nombre: f for f in filas})
        volumen: dict[str, int] = {}
        for tabla in por_mes:
            for nombre, fila in tabla.items():
                volumen[nombre] = volumen.get(nombre, 0) + fila.tot
        elegidas = sorted((n for n, tot in volumen.items() if tot >= max(1, int(min_ordenes))),
                          key=lambda n: -volumen[n])[: max(1, min(int(limite), 50))]
        entidades = []
        for nombre in elegidas:
            serie = [
                {"mes": m, "tot": t[nombre].tot, "efectividad": t[nombre].ef_adj, "perdidas": t[nombre].pe,
                 "pct_perdidas": round(100 * t[nombre].pe / t[nombre].tot, 1)}
                for m, t in zip(meses, por_mes) if nombre in t and t[nombre].tot
            ]
            entidades.append({"nombre": nombre, "tot": volumen[nombre], "serie": serie, **self._resumen_serie(serie)})
        if not entidades:
            return {"error": "sin_datos", "sugerencia": "Ese recorte no tiene órdenes en ningún mes."}, None

        salida = {
            "base": base, "dimension": dimension, "meses": meses, "entidades": entidades,
            "total_entidades": len(volumen), "datos_hasta": self.metrics.datos.fecha_max,
            "nota": ("Una serie por entidad, de las de mayor volumen. `efectividad` es la ajustada de cada mes. "
                     "Presenta TODAS las entidades que devuelve, mes por mes, con su variación." +
                     ("" if len(volumen) <= len(entidades)
                      else f" Hay {len(volumen)} en total; se muestran {len(entidades)}: dilo.") +
                     self._avisos(meses=meses)),
        }
        if nombres_tec:
            filtro = filtro.model_copy(update={"tecnicos": nombres_tec})
        if not (dimension == "tecnico" and nombres_tec):
            filtro = self._marcar(filtro, dimension, [e["nombre"] for e in entidades])
        return salida, filtro
