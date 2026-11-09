"""Métricas operativas calculadas sobre el payload del ETL.

La agregación es un espejo de la del tablero (`web/src/components/Tablero.js`): mismos
conteos, mismo criterio de "no controlable", mismas dos efectividades. Al leer los mismos archivos que
el tablero, las cifras del chat no pueden discrepar de las del mapa.

Todo ocurre en memoria: recorrer 177k enteros toma decenas de milisegundos, así
que no hace falta caché ni precalentado.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Sequence

from app.core.texto import norm, norm_dato
from app.schemas.metrics import CandidatoBarrio, Efectividad, FilaCausa
from app.services.payload_store import Payload, leer_nics, obtener

logger = logging.getLogger(__name__)


def _palabras(texto: str, *, sin_numeros: bool = False) -> frozenset[str]:
    """Las palabras de un nombre, sin tildes ni mayúsculas, para compararlo sin importar el orden."""
    limpio = unicodedata.normalize("NFKD", str(texto).lower())
    limpio = "".join(c for c in limpio if not unicodedata.combining(c))
    palabras = re.findall(r"[a-z0-9]+", limpio)
    return frozenset(p for p in palabras if not (sin_numeros and p.isdigit()))


# Sin brigada, actividad ni municipio: en Acuacar solo hay una (ISES, el tipo de OS y Cartagena),
# así que ordenar por ellas no distingue nada.
_PARENTESIS_FINALES = re.compile(r"(?:\s*\([^()]*\))+\s*$")


def _sin_zona(barrio: str) -> str:
    """'OLAYA HERRERA (COM 5) (C07)' -> 'OLAYA HERRERA'.

    El ETL le pega la zona al nombre para que cada unidad del mapa tenga una, y algunos
    barrios ya traen la comuna entre paréntesis: ambas cosas se quitan al comparar nombres.
    """
    return _PARENTESIS_FINALES.sub("", barrio)


DIMENSIONES = ("tecnico", "barrio", "zona", "corregimiento", "subaccion", "tarifa", "causa", "tipo_os")


class Ranking(list):
    """Las filas de un ranking y, en `total`, cuántas había antes de recortar al límite.

    Sin el total, «¿cuántos técnicos trabajaron?» solo se podía contestar contando las
    filas que alcanzaban a mostrarse, y el modelo respondía «al menos 10».
    """

    total: int = 0


class BarrioNoEncontrado(Exception):
    def __init__(self, texto: str) -> None:
        super().__init__(texto)
        self.texto = texto


class BarrioAmbiguo(Exception):
    def __init__(self, texto: str, candidatos: Sequence[CandidatoBarrio]) -> None:
        super().__init__(texto)
        self.texto = texto
        self.candidatos = list(candidatos)


class FiltroNoResuelto(Exception):
    """Un filtro de catálogo (municipio, zona, tarifa...) no resolvió a un
    único valor del payload: o no existe, o encaja en más de uno.

    Antes esto hacía que `_agrupar` devolviera {} en silencio, y el llamador no
    tenía forma de distinguirlo de «de verdad no hay órdenes»: el caso real fue
    `municipio="Atlántico"` —el departamento, no un municipio— que vació TODO el
    cálculo, incluido el filtro de tarifa que sí era válido, y el mensaje que
    volvió le echó la culpa al mínimo de órdenes pedido en vez de al filtro.
    """

    def __init__(self, campo: str, valor: str, catalogo: Sequence[str]) -> None:
        super().__init__(f"{campo}={valor!r} no está en el catálogo")
        self.campo = campo
        self.valor = valor
        self.catalogo = list(catalogo)


@dataclass
class Conteo:
    """Acumulador por grupo. Espejo del `bump()` de page.js."""

    tot: int = 0
    ef: int = 0
    pe: int = 0
    noctrl: int = 0
    causas: dict[int, int] = field(default_factory=dict)

    def sumar(self, estado: int, causa: int, no_controlable: bool) -> None:
        self.tot += 1
        if estado == 0:
            self.ef += 1
        else:
            self.pe += 1
        if no_controlable:
            self.noctrl += 1
        if estado != 0:
            self.causas[causa] = self.causas.get(causa, 0) + 1


def _pct(x: int, y: int) -> float:
    return round(x / y * 100, 1) if y else 0.0


def _wilson_lower(exitos: int, n: int) -> float:
    """Límite inferior de Wilson al 95%, espejo de page.js:884."""
    if not n:
        return 0.0
    z = 1.96
    p = exitos / n
    d = 1 + (z * z) / n
    c = p + (z * z) / (2 * n)
    m = z * math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
    return max(0.0, (c - m) / d)


# Criterios por los que se puede ordenar un ranking. En Acuacar no existe «Fallida»:
# una orden o es Efectiva o es Perdida (efectividad = 'No efectiva').
CRITERIOS = {
    "ef_adj": lambda f: f.ef_adj,
    "ef_pct": lambda f: f.ef_pct,
    "ef_pond": lambda f: f.ef_pond or 0.0,
    "ef_adj_pond": lambda f: f.ef_adj_pond or 0.0,
    "perdidas": lambda f: f.pe,
    "pct_perdidas": lambda f: f.pe / f.tot if f.tot else 0.0,
    "volumen": lambda f: f.tot,
    "efectivas": lambda f: f.ef,
}


# Órdenes "prestadas" de la media que se le suman a cada grupo al ponderar. Con
# 50, un barrio de 10 órdenes queda dominado por ellas y uno de 400 apenas se
# mueve, que es justo el efecto buscado: exigir muestra para creerle a un
# porcentaje. Es del orden del volumen típico de un barrio en un mes; subirlo
# aplana el ranking y bajarlo deja colarse otra vez a los de muestra mínima.
PESO_PREVIO = 50


def _ponderar(exitos: int, base: int, media: float) -> float:
    """Acerca el porcentaje a la media del conjunto según la muestra.

    El promedio ponderado de siempre: a `base` intentos observados se le suman
    `PESO_PREVIO` imaginarios que salieron como el promedio. Con poca muestra
    mandan los imaginarios y el grupo se pega a la media; con mucha, pesan tan
    poco que el porcentaje real queda casi intacto.

    Sin esto, «el mejor barrio» era siempre uno de diez órdenes que salieron
    todas bien, y los barrios con historia no aparecían nunca.
    """
    if base <= 0:
        # Sin nada observado, lo único honesto es la media: no sabemos si es
        # bueno o malo. Devolver 0 lo mandaba a encabezar «los peores», y hay
        # barrios enteros con todas sus órdenes fuera de control de la operación
        # —su denominador ajustado es 0— que aparecían como el peor del mes sin
        # tener una sola orden que se les pudiera reprochar.
        return round(media * 100, 1)
    return round((exitos + PESO_PREVIO * media) / (base + PESO_PREVIO) * 100, 1)


def _a_dto(conteo: Conteo, nombre: str, municipio: str | None = None) -> Efectividad:
    den = conteo.tot - conteo.noctrl
    return Efectividad(
        nombre=nombre,
        municipio=municipio,
        tot=conteo.tot,
        ef=conteo.ef,
        pe=conteo.pe,
        noctrl=conteo.noctrl,
        ef_pct=_pct(conteo.ef, conteo.tot),
        ef_adj=_pct(conteo.ef, den) if den > 0 else 0.0,
    )


class MetricsService:
    """Consultas de negocio sobre el payload. Los métodos son `async` solo para
    no cambiar el contrato con `tools.py`; el cálculo es síncrono."""

    def __init__(self, directorio: Path) -> None:
        self.directorio = directorio
        # Recorrer 177k filas por cada candidato saldría caro; se hace una vez.
        self._totales: list[int] | None = None

    @property
    def datos(self) -> Payload:
        return obtener(self.directorio)

    # --- Resolución de nombres ------------------------------------------------

    async def buscar_barrios(
        self, texto: str, limite: int | None = None
    ) -> list[CandidatoBarrio]:
        """Busca por el nombre del barrio (sin el municipio), tolerando tildes.

        Sin `limite` devuelve todos: recortar aquí hacía que una desambiguación
        listara 7 de 10 barrios y el usuario no encontrara el suyo.
        """
        p = self.datos
        objetivo = norm_dato(texto)
        if not objetivo:
            return []

        encontrados = [
            self._candidato(i)
            for i, bkey in enumerate(p.barrios)
            if objetivo in norm_dato(bkey.partition(" | ")[2])
        ]
        encontrados.sort(key=lambda c: c.tot, reverse=True)
        return encontrados[:limite] if limite else encontrados

    async def resolver_barrio(
        self, texto: str, *, municipio: str | None = None
    ) -> CandidatoBarrio:
        """Devuelve el barrio único que coincide con el texto.

        Args:
            texto: nombre del barrio, o la clave completa "MUNICIPIO | BARRIO".
            municipio: pista para desempatar cuando el nombre se repite. Hay
                barrios homónimos en varios municipios (LAS MALVINAS está en
                Barranquilla y en Campo de la Cruz).

        Raises:
            BarrioNoEncontrado: si no coincide ninguno.
            BarrioAmbiguo: si quedan varios y no hay con qué desempatar.
        """
        # Clave completa: no hay nada que adivinar.
        if " | " in texto:
            objetivo = norm_dato(texto)
            for i, bkey in enumerate(self.datos.barrios):
                if norm_dato(bkey) == objetivo:
                    return self._candidato(i)

            # La clave no existe tal cual. Pasa siempre por lo mismo: el chat ve
            # "BARRANQUILLA | OLAYA" en los filtros activos, copia ese formato y
            # pide "BARRANQUILLA | EL CONCORD" aunque El Concord sea de Malambo.
            # Se reintenta con las dos mitades por separado, porque seguir de
            # largo buscaba la clave ENTERA entre los nombres de barrio —donde el
            # municipio nunca aparece— y siempre daba "no encontrado".
            muni_texto, _, barrio_texto = texto.partition(" | ")
            return await self.resolver_barrio(
                barrio_texto, municipio=municipio or muni_texto
            )

        candidatos = await self.buscar_barrios(texto)
        if not candidatos:
            raise BarrioNoEncontrado(texto)

        # El municipio acota ANTES de preferir coincidencias exactas. Al revés,
        # "Los Robles" mirando Soledad se quedaba con el homónimo de Sabanalarga
        # y descartaba las diez etapas que el usuario sí tenía en pantalla.
        if municipio:
            del_municipio = [
                c for c in candidatos if norm_dato(c.municipio) == norm_dato(municipio)
            ]
            if del_municipio:
                candidatos = del_municipio

        if len(candidatos) == 1:
            return candidatos[0]

        objetivo = norm_dato(texto)
        exactos = [c for c in candidatos if norm_dato(_sin_zona(c.barrio)) == objetivo]
        if len(exactos) == 1:
            return exactos[0]

        raise BarrioAmbiguo(texto, exactos or candidatos)

    def indices_tecnico(self, pedido: str | Sequence[str]) -> list[int]:
        """Índices del catálogo de técnicos para uno o varios nombres.

        Acepta el nombre en cualquier orden y sin tildes: «Veronica Bellido» encuentra
        «BELLIDO MAZO VERONICA - 32761740». Un nombre que no existe, o que encaja en
        más de un técnico (un apellido común), lanza `FiltroNoResuelto` con los
        candidatos: devolver el total sin filtrar, o elegir uno al azar, daría una cifra
        de otra persona sin avisar.
        """
        catalogo = self.datos.tecs
        nombres = [pedido] if isinstance(pedido, str) else list(pedido)
        encontrados: list[int] = []
        for texto in nombres:
            pedidas = _palabras(texto)
            coinciden = [i for i, n in enumerate(catalogo) if pedidas and pedidas <= _palabras(n)]
            # Con la cédula pegada al nombre pueden quedar varios: si uno solo tiene
            # exactamente las palabras pedidas (sin números), ese es.
            exactos = [i for i in coinciden if _palabras(catalogo[i], sin_numeros=True) == _palabras(texto, sin_numeros=True)]
            elegido = exactos if len(exactos) == 1 else coinciden
            if len(elegido) != 1:
                raise FiltroNoResuelto("tecnico", texto, [catalogo[i] for i in elegido] or catalogo[:20])
            encontrados.append(elegido[0])
        return list(dict.fromkeys(encontrados))

    def visitas_tecnico(
        self,
        tecnicos: Sequence[int],
        *,
        bkeys: Sequence[str] | None = None,
        municipio: str | None = None,
        meses: Sequence[str] | None = None,
        estado: str | None = None,
        limite: int = 30,
    ) -> dict:
        """Las visitas (órdenes o gestiones) de uno o varios técnicos, de la más reciente a la más antigua.

        Devuelve el total y el desglose por estado de TODO el recorte, y solo `limite` filas:
        listar cientos de visitas al modelo no ayuda a nadie y el total sí hay que decirlo.
        """
        p = self.datos
        f_tecs = set(tecnicos)
        f_barrios = self._indices_barrio(bkeys) if bkeys else None
        f_muni = self._indice(p.munis, municipio)
        if municipio is not None and f_muni is None:
            raise FiltroNoResuelto("municipio", municipio, p.munis)
        f_meses = {p.meses.index(m) for m in meses if m in p.meses} if meses else None
        if meses and not f_meses:
            return {"total": 0, "por_estado": {}, "filas": []}
        f_estado = {"efectiva": 0, "perdida": 2}[norm_dato(estado)] if estado else None

        inicio = datetime.strptime(p.fecha_min, "%Y-%m-%d")
        nombres_estado = {0: "Efectiva", 2: "Perdida"}
        halladas: list[int] = []
        por_estado = {n: 0 for n in nombres_estado.values()}
        for i in range(len(p.e)):
            if p.t[i] not in f_tecs:
                continue
            bi = p.b[i]
            if f_barrios is not None and bi not in f_barrios:
                continue
            if f_muni is not None and p.b_muni[bi] != f_muni:
                continue
            if f_meses is not None and p.mes[i] not in f_meses:
                continue
            if f_estado is not None and p.e[i] != f_estado:
                continue
            halladas.append(i)
            por_estado[nombres_estado[p.e[i]]] += 1

        halladas.sort(key=lambda i: p.m[i], reverse=True)
        mostradas = halladas[:limite]
        # El NIC no vive en las columnas en memoria: se lee del archivo del mes solo para las que se muestran.
        nics: dict[tuple[str, int], str] = {}
        por_mes: dict[str, list[int]] = {}
        for i in mostradas:
            mes_key = p.meses[p.mes[i]]
            por_mes.setdefault(mes_key, []).append(i - p.inicio_mes[p.mes[i]])
        for mes_key, posiciones in por_mes.items():
            for local, nic in leer_nics(self.directorio, mes_key, posiciones).items():
                nics[(mes_key, local)] = nic

        filas = []
        for i in mostradas:
            mes_key = p.meses[p.mes[i]]
            filas.append({
                "fecha": (inicio + timedelta(minutes=p.m[i])).strftime("%Y-%m-%d %H:%M"),
                "barrio": p.barrios[p.b[i]],
                "estado": nombres_estado[p.e[i]],
                "causa": p.causas[p.c[i]],
                "subaccion": p.subs[p.s[i]],
                "nic": nics.get((mes_key, i - p.inicio_mes[p.mes[i]]), ""),
            })
        return {"total": len(halladas), "por_estado": {k: v for k, v in por_estado.items() if v}, "filas": filas}

    # --- Métricas -------------------------------------------------------------

    async def efectividad(
        self,
        *,
        bkeys: Sequence[str] | None = None,
        municipio: str | None = None,
        zona: str | Sequence[str] | None = None,
        corregimiento: str | Sequence[str] | None = None,
        meses: Sequence[str] | None = None,
        tipo_os: str | None = None,
        brigada: str | None = None,
        subaccion: str | None = None,
        tarifa: str | None = None,
        actividad: str | None = None,
        causa: str | None = None,
        tecnicos: Sequence[int] | None = None,
        etiqueta: str | None = None,
    ) -> Efectividad:
        """Efectividad del recorte indicado. Sin filtros, de todo el histórico.

        `bkeys` admite varios barrios porque un nombre como "Los Robles" puede
        corresponder a diez etapas que son un mismo sitio para quien pregunta.
        """
        conteos = self._agrupar(
            bkeys=bkeys, municipio=municipio, zona=zona, corregimiento=corregimiento, meses=meses,
            tipo_os=tipo_os, brigada=brigada, subaccion=subaccion, tarifa=tarifa,
            actividad=actividad, causa=causa, tecnicos=tecnicos,
        )
        nombre = etiqueta or self._etiqueta(bkeys, municipio, zona)
        return _a_dto(conteos.get(0, Conteo()), nombre)

    async def ranking(
        self,
        *,
        dimension: str = "brigada",
        bkeys: Sequence[str] | None = None,
        municipio: str | None = None,
        zona: str | Sequence[str] | None = None,
        corregimiento: str | Sequence[str] | None = None,
        meses: Sequence[str] | None = None,
        tipo_os: str | None = None,
        brigada: str | None = None,
        subaccion: str | None = None,
        tarifa: str | None = None,
        actividad: str | None = None,
        causa: str | None = None,
        tecnicos: Sequence[int] | None = None,
        min_ordenes: int = 10,
        limite: int = 10,
        ascendente: bool = False,
        ordenar_por: str = "ef_adj",
    ) -> list[Efectividad]:
        """Ordena brigadas, técnicos o barrios por el criterio pedido.

        Por defecto la efectividad ajustada, que es como el tablero ordena estos
        rankings (Dock.js:295): comparar por la cruda castiga a quien recibe más
        órdenes con causas fuera de su control.

        Pero no toda pregunta se contesta con efectividad. «Dónde pierdo más» se
        ordena por órdenes perdidas, que son las que no se cobran; responderla con
        efectividad devuelve barrios sin una sola pérdida.
        """
        if dimension not in DIMENSIONES:
            raise ValueError(f"Dimensión no soportada: {dimension}")
        if ordenar_por not in CRITERIOS:
            raise ValueError(f"Criterio no soportado: {ordenar_por}")

        p = self.datos
        conteos = self._agrupar(
            bkeys=bkeys, municipio=municipio, zona=zona, corregimiento=corregimiento, meses=meses,
            tipo_os=tipo_os, brigada=brigada, subaccion=subaccion, tarifa=tarifa,
            actividad=actividad, causa=causa, tecnicos=tecnicos, por=dimension,
        )
        catalogo = self._catalogo(dimension)

        # Las medias salen de TODO el recorte, incluidos los grupos que luego
        # descarta `min_ordenes`: son la referencia contra la que se compara cada
        # uno, y calcularlas solo sobre los que pasan el corte las sesgaría.
        tot_global = sum(c.tot for c in conteos.values())
        ef_global = sum(c.ef for c in conteos.values())
        den_global = sum(c.tot - c.noctrl for c in conteos.values())
        media = ef_global / tot_global if tot_global else 0.0
        media_adj = ef_global / den_global if den_global > 0 else 0.0

        filas = []
        for i, c in conteos.items():
            if c.tot < min_ordenes:
                continue
            fila = _a_dto(c, catalogo[i])
            fila.ef_pond = _ponderar(c.ef, c.tot, media)
            fila.ef_adj_pond = _ponderar(c.ef, c.tot - c.noctrl, media_adj)
            filas.append(fila)

        filas.sort(key=CRITERIOS[ordenar_por], reverse=not ascendente)
        recortadas = Ranking(filas[:limite])
        recortadas.total = len(filas)
        return recortadas

    def _catalogo(self, dimension: str) -> list[str]:
        p = self.datos
        return {
            "brigada": p.brigs, "tecnico": p.tecs, "barrio": p.barrios, "subaccion": p.subs,
            "tarifa": p.tarifas, "actividad": p.acts, "municipio": p.munis, "zona": p.zonas, "corregimiento": p.corrs,
            "causa": p.causas, "tipo_os": p.tipos,
        }[dimension]

    async def causas(
        self,
        *,
        bkeys: Sequence[str] | None = None,
        municipio: str | None = None,
        zona: str | Sequence[str] | None = None,
        corregimiento: str | Sequence[str] | None = None,
        meses: Sequence[str] | None = None,
        tipo_os: str | None = None,
        brigada: str | None = None,
        subaccion: str | None = None,
        tarifa: str | None = None,
        actividad: str | None = None,
        causa: str | None = None,
        tecnicos: Sequence[int] | None = None,
        limite: int = 6,
    ) -> list[FilaCausa]:
        """Causas de las órdenes NO efectivas, de mayor a menor."""
        p = self.datos
        conteo = self._agrupar(
            bkeys=bkeys, municipio=municipio, zona=zona, corregimiento=corregimiento, meses=meses,
            tipo_os=tipo_os, brigada=brigada, subaccion=subaccion, tarifa=tarifa,
            actividad=actividad, causa=causa, tecnicos=tecnicos,
        ).get(0, Conteo())

        total = sum(conteo.causas.values())
        ordenadas = sorted(conteo.causas.items(), key=lambda kv: kv[1], reverse=True)
        return [
            FilaCausa(
                causa=p.causas[c],
                familia=p.causa_fam[c],
                n=n,
                pct=_pct(n, total),
                controlable=bool(p.causa_ctrl[c]),
            )
            for c, n in ordenadas[:limite]
        ]

    async def meses_disponibles(self) -> list[str]:
        """Meses con datos, del más reciente al más antiguo."""
        return list(reversed(self.datos.meses))

    # --- Interno --------------------------------------------------------------

    @staticmethod
    def _etiqueta(
        bkeys: Sequence[str] | None, municipio: str | None, zona: str | Sequence[str] | None
    ) -> str:
        """Nombre legible del recorte, para que la cifra nunca viaje sin su alcance."""
        if bkeys:
            if len(bkeys) == 1:
                return bkeys[0]
            comun = bkeys[0].partition(" | ")[0]
            return f"{len(bkeys)} barrios de {comun}"
        return municipio or zona or "Todo Cartagena"

    def _candidato(self, i: int) -> CandidatoBarrio:
        p = self.datos
        return CandidatoBarrio(
            bkey=p.barrios[i],
            barrio=p.barrios[i].partition(" | ")[2],
            municipio=p.munis[p.b_muni[i]],
            tot=self._totales_por_barrio()[i],
        )

    def _totales_por_barrio(self) -> list[int]:
        if self._totales is None:
            p = self.datos
            totales = [0] * len(p.barrios)
            for bi in p.b:
                totales[bi] += 1
            self._totales = totales
        return self._totales

    def _indice(self, catalogo: list[str], valor: str | None) -> int | None:
        """Traduce un nombre a su índice, tolerando tildes y mayúsculas."""
        if valor is None:
            return None
        objetivo = norm_dato(valor)
        for i, nombre in enumerate(catalogo):
            if norm_dato(nombre) == objetivo:
                return i
        return None

    def _indices(self, catalogo: list[str], valor: str | Sequence[str] | None) -> set[int] | None:
        """Como `_indice`, pero admite varios nombres: el conjunto de sus índices.

        None si no se pidió ninguno, o si alguno no existe (el llamador lo distingue con el
        pedido original y lanza FiltroNoResuelto).
        """
        if not valor:
            return None
        nombres = [valor] if isinstance(valor, str) else list(valor)
        hallados = {self._indice(catalogo, n) for n in nombres}
        return None if None in hallados else hallados

    def _indice_parcial(self, catalogo: list[str], valor: str | None) -> int | None:
        """Como `_indice`, pero acepta el nombre a medias.

        Los catálogos de tarifa y subacción tienen nombres largos que nadie
        escribe enteros: se pregunta por «estrato 3», no por «RESIDENCIAL |
        ESTRATO 3». Se intenta en cuatro pasadas, de la más estricta a la más
        laxa:

        1. El nombre completo.
        2. El último tramo, el que va después de la barra.
        3. Subcadena: el valor buscado aparece dentro del nombre del catálogo.
        4. Subcadena inversa: el nombre del catálogo aparece dentro del valor
           buscado. Cubre «Cobro Persuasivo Residencial» cuando el catálogo
           solo tiene «COBRO PERSUASIVO».

        En las pasadas 3 y 4, solo se acepta si hay exactamente un candidato.
        """
        if valor is None:
            return None
        objetivo = norm_dato(valor)
        if not objetivo:
            return None

        for i, nombre in enumerate(catalogo):
            if norm_dato(nombre) == objetivo:
                return i
        for pasada in (
            lambda n: norm_dato(n.split("|")[-1]) == objetivo,
            lambda n: objetivo in norm_dato(n),
            lambda n: norm_dato(n) in objetivo,
        ):
            candidatos = [i for i, n in enumerate(catalogo) if pasada(n)]
            if len(candidatos) == 1:
                return candidatos[0]
            if candidatos:
                return None
        return None

    def _indices_tarifa(self, valor: str | None) -> set[int] | None:
        """Todas las tarifas que encajan con lo pedido.

        «Estrato 3» son tres códigos del catálogo (31, 32, 36) pero una sola pregunta para
        quien la hace: se suman. Un código exacto («31») o el nombre entero van a una sola.
        Conjunto vacío si no encaja ninguna, para que `_agrupar` lo reporte como filtro no resuelto.
        """
        if valor is None:
            return None
        objetivo = norm_dato(valor)
        if not objetivo:
            return set()
        exactas = {i for i, n in enumerate(self.datos.tarifas) if norm_dato(n) == objetivo or norm_dato(n.partition(" · ")[0]) == objetivo}
        if exactas:
            return exactas
        return {i for i, n in enumerate(self.datos.tarifas) if objetivo in norm_dato(n)}

    def _indices_barrio(self, bkeys: Sequence[str]) -> set[int] | None:
        """Índices de los barrios pedidos. `None` si alguno no existe."""
        p = self.datos
        encontrados = set()
        for bkey in bkeys:
            i = self._indice(p.barrios, bkey)
            if i is None:
                return None
            encontrados.add(i)
        return encontrados

    def _agrupar(
        self,
        *,
        bkeys: Sequence[str] | None = None,
        municipio: str | None = None,
        zona: str | Sequence[str] | None = None,
        corregimiento: str | Sequence[str] | None = None,
        meses: Sequence[str] | None = None,
        tipo_os: str | None = None,
        brigada: str | None = None,
        subaccion: str | None = None,
        tarifa: str | None = None,
        actividad: str | None = None,
        causa: str | None = None,
        tecnicos: Sequence[int] | None = None,
        por: str | None = None,
        por2: str | None = None,
        visitar: Callable[[int], None] | None = None,
    ) -> dict:
        """Recorre las órdenes una vez, filtrando y acumulando.

        Sin `por`, todo cae en la clave 0. El criterio de no controlable es el
        mismo del tablero: `estado != Efectiva AND causa no controlable`.
        """
        p = self.datos

        # Cartagena es el único municipio del payload: filtrar por él no recorta nada, y
        # el nombre largo del catálogo («CARTAGENA DE INDIAS») no lo escribe nadie.
        municipio = None
        f_barrios = self._indices_barrio(bkeys) if bkeys else None
        f_muni = self._indice(p.munis, municipio)
        zona, corregimiento = zona or None, corregimiento or None
        f_zona = self._indices(p.zonas, zona)
        f_corr = self._indices(p.corrs, corregimiento)
        f_tipo = self._indice_parcial(p.tipos, tipo_os)
        f_brig = self._indice(p.brigs, brigada)
        # Parcial: nadie escribe «RESIDENCIAL | ESTRATO 3» ni «RED CHILENA/CONFIG.
        # ESPECIAL» enteros.
        f_sub = self._indice_parcial(p.subs, subaccion)
        f_tarifa = self._indices_tarifa(tarifa)
        f_act = self._indice_parcial(p.acts, actividad) if p.acts else None
        f_causa = self._indice_parcial(p.causas, causa)
        # Conjunto y no índice: «todo 2026» son varios meses, no uno. Queda en
        # None si no se pidió ninguno, y vacío si ninguno de los pedidos existe
        # —que no es lo mismo y abajo se distinguen.
        f_meses = {p.meses.index(m) for m in meses if m in p.meses} if meses else None

        # `bkeys` y `meses` ya llegan resueltos por `_recorte`/`expandir_meses` en
        # el camino normal: si de todos modos no calzan, el total sin filtrar
        # sería peor que vacío —el usuario creería que la cifra es de su barrio—,
        # así que aquí se quedan en el criterio silencioso de siempre.
        for pedido, resuelto in ((bkeys, f_barrios), (meses, f_meses or None)):
            if pedido is not None and resuelto is None:
                logger.info("Filtro sin coincidencia: %r", pedido)
                return {}

        # Estos seis SÍ llegan como texto libre del modelo, sin pasar por nada
        # que los valide antes. Si no resuelven, no se puede seguir con el resto
        # del cálculo como si ese filtro no existiera: hay que decirlo.
        for campo, pedido, resuelto, catalogo in (
            ("municipio", municipio, f_muni, p.munis),
            ("zona", zona, f_zona, p.zonas),
            ("corregimiento", corregimiento, f_corr, p.corrs),
            ("tipo_os", tipo_os, f_tipo, p.tipos),
            ("brigada", brigada, f_brig, p.brigs),
            ("subaccion", subaccion, f_sub, p.subs),
            ("tarifa", tarifa, f_tarifa or None, p.tarifas),
            ("actividad", actividad, f_act, p.acts),
            ("causa", causa, f_causa, p.causas),
        ):
            if pedido is not None and resuelto is None:
                raise FiltroNoResuelto(campo, str(pedido), catalogo)

        B, C, E, MES, O, G, S, F = p.b, p.c, p.e, p.mes, p.o, p.g, p.s, p.f
        A = p.a
        T = p.t
        # Índices ya resueltos por `indices_tecnico`: vacío significa «ninguno», no «todos».
        f_tecs = set(tecnicos) if tecnicos is not None else None
        ctrl, b_muni, b_zona = p.causa_ctrl, p.b_muni, p.b_zona
        b_corr = p.b_corr
        columnas = {
            "brigada": p.g, "tecnico": p.t, "barrio": p.b,
            "subaccion": p.s, "tarifa": p.f, "actividad": A,
            "causa": C, "tipo_os": O,
        }
        grupo = columnas.get(por)
        # b_muni es per-barrio, no per-orden: se resuelve aparte en la clave.
        grupo_es_municipio = por == "municipio"
        grupo_es_zona = por == "zona"
        grupo_es_corr = por == "corregimiento"
        # Cruce con una segunda dimensión: la clave pasa a ser el par (primera, segunda).
        grupo2 = columnas.get(por2)

        conteos: dict[int, Conteo] = {}
        for i in range(len(E)):
            bi = B[i]
            if f_barrios is not None and bi not in f_barrios:
                continue
            if f_muni is not None and b_muni[bi] != f_muni:
                continue
            if f_zona is not None and b_zona[bi] not in f_zona:
                continue
            if f_corr is not None and b_corr[bi] not in f_corr:
                continue
            if f_meses is not None and MES[i] not in f_meses:
                continue
            if f_tipo is not None and O[i] != f_tipo:
                continue
            if f_brig is not None and G[i] != f_brig:
                continue
            if f_sub is not None and S[i] != f_sub:
                continue
            if f_tarifa is not None and F[i] not in f_tarifa:
                continue
            if f_act is not None and A[i] != f_act:
                continue
            if f_causa is not None and C[i] != f_causa:
                continue
            if f_tecs is not None and T[i] not in f_tecs:
                continue
            if visitar is not None:
                visitar(i)  # quien necesita algo más que el conteo (el riesgo) lo lee de cada orden

            if grupo_es_municipio:
                clave = b_muni[bi]
            elif grupo_es_zona:
                clave = b_zona[bi]
            elif grupo_es_corr:
                clave = b_corr[bi]
            else:
                clave = grupo[i] if grupo is not None else 0
            if por2:
                clave = (clave, b_muni[bi] if por2 == "municipio" else b_zona[bi] if por2 == "zona" else b_corr[bi] if por2 == "corregimiento" else grupo2[i])
            conteo = conteos.get(clave)
            if conteo is None:
                conteo = conteos[clave] = Conteo()

            estado, causa = E[i], C[i]
            conteo.sumar(estado, causa, estado != 0 and ctrl[causa] == 0)

        return conteos
