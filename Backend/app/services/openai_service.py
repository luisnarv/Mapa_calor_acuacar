"""Servicio de OpenAI: única puerta de salida hacia la API del proveedor.

Los endpoints no conocen el SDK; hablan con este servicio y reciben DTOs propios.
El modelo puede pedir datos a través de las herramientas de `services.tools`: se
ejecutan aquí, se le devuelven como JSON y con eso redacta la respuesta.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    RateLimitError,
)

from app.core.config import settings
from app.core.texto import norm_dato
from app.schemas.chat import ChatRequest, VistaTablero
from app.schemas.metrics import FiltroMapa
from app.services.tools import TOOLS, ToolRunner

logger = logging.getLogger(__name__)

# Colombia no tiene horario de verano, así que un desfase fijo de -5 es exacto
# y evita depender de la zona horaria del servidor (en la nube suele ser UTC).
COLOMBIA = timezone(timedelta(hours=-5))

# Tope de idas y vueltas modelo -> herramienta -> modelo. Sin esto, un modelo
# confundido puede quedarse pidiendo datos en bucle y consumir la cuota.
MAX_RONDAS = 4

# Solo se usa si tras el cierre forzado el modelo sigue sin redactar nada.
AVISO_SIN_CIERRE = "\n\n(No pude cerrar la consulta; intenta con una pregunta mas concreta.)"


def _unificar_filtros(filtros: list[FiltroMapa]) -> dict[str, Any] | None:
    """Un turno mueve el tablero una sola vez, o no lo mueve.

    Antes cada llamada a una herramienta emitía su filtro en cuanto terminaba, y
    con dos llamadas en un turno —«en junio y agosto»— la segunda pisaba a la
    primera: la respuesta hablaba de dos meses y el mapa enseñaba uno, sin que
    nada avisara. Es el mismo error de los bugs 5 y 6 entrando por otra puerta.

    Los filtros se funden cuando no se contradicen: ninguna dimensión (barrio,
    zona, tipo de orden...) toma dos valores distintos. Los meses siempre se unen, que es
    lo que el usuario pidió ver. Así el ranking por municipio y el barrio ganador que
    el modelo marca después son un solo recorte (el barrio, dentro de ese municipio),
    no dos «distintos»: antes el mapa se quedaba quieto aunque ambos hablaran de lo
    mismo, y la respuesta decía «ya lo marqué». Cuando sí se contradicen —dos barrios
    distintos— no hay un tablero que muestre las dos cosas a la vez, así que se deja
    quieto: peor que no moverlo es moverlo a la mitad de la respuesta.
    """
    utiles = [f for f in filtros if f.model_dump(exclude_none=True)]
    if not utiles:
        return None

    # Se comparan sin mayúsculas ni acentos: el ranking filtra por «Barranquilla», como
    # lo escribió el modelo, y filtrar_mapa devuelve «BARRANQUILLA». Son lo mismo.
    campos: dict[str, Any] = {}
    listas: dict[str, list[str]] = {}
    for f in utiles:
        for campo, valor in f.model_dump(exclude={"meses"}, exclude_none=True).items():
            if campo == "capas":
                # Encender una capa no contradice a otra: se suman.
                campos[campo] = sorted({*campos.get(campo, []), *valor})
            elif campo in ("barrios", "tecnicos"):
                previa = listas.get(campo)
                if previa is not None and {norm_dato(b) for b in previa} != {norm_dato(b) for b in valor}:
                    return None
                listas[campo] = valor
            elif norm_dato(campos.setdefault(campo, valor)) != norm_dato(valor):
                return None
    barrios = listas.get("barrios")

    # Un barrio suelto dentro de la lista pedida es lo mismo; fuera de ella, un conflicto.
    if barrios is not None and "barrio" in campos:
        if norm_dato(campos["barrio"]) not in {norm_dato(b) for b in barrios}:
            return None
        del campos["barrio"]

    # Un barrio de otro municipio no se funde con el pedido: el tablero saldría vacío.
    municipio = campos.get("municipio")
    for barrio in ([campos["barrio"]] if "barrio" in campos else []) + (barrios or []):
        if municipio and norm_dato(barrio.partition(" | ")[0]) != norm_dato(municipio):
            return None

    meses = sorted({m for f in utiles for m in (f.meses or [])})
    vacio = {campo: None for campo in FiltroMapa.model_fields if campo != "meses"}
    return {"tipo": "filtrar_mapa", **vacio, **campos, "barrios": barrios,
            "tecnicos": listas.get("tecnicos"), "meses": meses or None}


class OpenAIServiceError(Exception):
    """Falla al hablar con OpenAI, ya traducida a un estado HTTP."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class OpenAIService:
    def __init__(self, client: AsyncOpenAI, default_model: str, system_prompt: str = "") -> None:
        self._client = client
        self._default_model = default_model
        self._system_prompt = system_prompt
        self._tools = TOOLS

    # --- API pública ---------------------------------------------------------

    @property
    def modelo_por_defecto(self) -> str:
        """Con cuál se responde si la petición no pide uno."""
        return self._default_model

    async def stream_chat(
        self, request: ChatRequest, runner: ToolRunner | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Emite `{"delta": ...}` con el texto y, al final, `{"accion": ...}` con el filtro del mapa."""
        model = request.model or self._default_model
        filtros: list[FiltroMapa] = []

        async for evento in self._conversar(request, runner, model, filtros):
            yield evento

        # Al final del turno, cuando ya se sabe cuántos recortes hubo. Llega después del
        # texto: el tablero se mueve al cerrar la respuesta, no a media redacción.
        if accion := _unificar_filtros(filtros):
            yield {"accion": accion}

    async def _conversar(
        self,
        request: ChatRequest,
        runner: ToolRunner | None,
        model: str,
        filtros: list[FiltroMapa],
    ) -> AsyncIterator[dict[str, Any]]:
        """El ciclo de tool calling. Si se pasa `runner`, el modelo puede consultar los datos;
        sin él responde solo con lo que sabe."""
        if runner is not None:
            # La vista llega en el cuerpo de cada turno: no se inyecta por DI.
            runner.vista = request.vista
        mensajes = self._build_messages(request)

        try:
            for ronda in range(MAX_RONDAS):
                texto, llamadas = "", {}

                extra = {"tools": self._tools, "tool_choice": "auto"} if runner else {}
                stream = await self._client.chat.completions.create(
                    model=model,
                    messages=mensajes,
                    temperature=request.temperature,
                    max_tokens=request.max_tokens,
                    stream=True,
                    **extra,
                )

                async for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    if delta.content:
                        texto += delta.content
                        yield {"delta": delta.content}
                    for parcial in delta.tool_calls or []:
                        self._acumular(llamadas, parcial)

                # Sin llamadas a herramientas, esta ronda ya fue la respuesta final.
                if not llamadas or runner is None:
                    return

                mensajes.append(self._mensaje_asistente(texto, llamadas))
                for llamada in llamadas.values():
                    resultado, filtro = await self._ejecutar(runner, llamada)
                    # `_recorte` arma un FiltroMapa aunque no haya recorte, así que
                    # un ranking de todo Cartagena devolvía uno con todos los
                    # campos vacíos. Al llegar al tablero no filtraba nada pero sí
                    # le cambiaba la pestaña al usuario, que es peor que no hacer
                    # nada: parece que respondió moviéndole la vista porque sí.
                    if filtro is not None:
                        filtros.append(filtro)
                    mensajes.append(
                        {
                            "role": "tool",
                            "tool_call_id": llamada["id"],
                            "content": json.dumps(resultado, ensure_ascii=False, default=str),
                        }
                    )
                logger.info(
                    "Ronda %s: %s herramienta(s) ejecutada(s).", ronda + 1, len(llamadas)
                )

            # Agotadas las rondas, se pide una ultima respuesta SIN herramientas.
            #
            # Antes se cortaba aqui con «no pude cerrar la consulta» aunque el
            # modelo tuviera ya todos los datos delante: habia consultado cuatro
            # veces y se le negaba la oportunidad de redactar con lo reunido. La
            # misma pregunta contestaba o no segun cuantas consultas se le
            # antojara hacer, que es lo ultimo que el usuario puede adivinar.
            async for evento in self._cerrar(model, mensajes, request, bool(runner)):
                yield evento
        except OpenAIServiceError:
            raise
        except Exception as exc:
            raise self._translate(exc) from exc

    async def close(self) -> None:
        await self._client.close()

    # --- Interno -------------------------------------------------------------

    async def _cerrar(
        self, model: str, mensajes: list[dict], request: ChatRequest, con_tools: bool
    ) -> AsyncIterator[dict[str, Any]]:
        """Ultima pasada, con tool_choice a none: obliga a responder con texto.

        Se le pasan las herramientas igualmente porque el historial ya contiene
        `tool_calls`; sin declararlas, la API rechaza la conversacion.
        """
        extra = {"tools": self._tools, "tool_choice": "none"} if con_tools else {}
        texto = ""
        try:
            stream = await self._client.chat.completions.create(
                model=model,
                messages=mensajes,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                stream=True,
                **extra,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                if contenido := chunk.choices[0].delta.content:
                    texto += contenido
                    yield {"delta": contenido}
        except Exception:
            logger.exception("Fallo el cierre tras agotar las rondas.")

        if not texto.strip():
            # Aqui si no hay nada que hacer: ni con los datos delante redacto.
            yield {"delta": AVISO_SIN_CIERRE}

    @staticmethod
    def _acumular(llamadas: dict[int, dict[str, str]], parcial: Any) -> None:
        """Junta los trozos de una tool call, que llegan repartidos en el stream."""
        slot = llamadas.setdefault(parcial.index, {"id": "", "name": "", "args": ""})
        if parcial.id:
            slot["id"] = parcial.id
        if parcial.function and parcial.function.name:
            slot["name"] += parcial.function.name
        if parcial.function and parcial.function.arguments:
            slot["args"] += parcial.function.arguments

    @staticmethod
    def _mensaje_asistente(texto: str, llamadas: dict[int, dict[str, str]]) -> dict[str, Any]:
        """Reconstruye el turno del asistente para que el modelo lo vea en la siguiente ronda."""
        return {
            "role": "assistant",
            "content": texto or None,
            "tool_calls": [
                {
                    "id": ll["id"],
                    "type": "function",
                    "function": {"name": ll["name"], "arguments": ll["args"] or "{}"},
                }
                for ll in llamadas.values()
            ],
        }

    @staticmethod
    async def _ejecutar(
        runner: ToolRunner, llamada: dict[str, str]
    ) -> tuple[dict[str, Any], FiltroMapa | None]:
        """Ejecuta una herramienta, tolerando argumentos mal formados."""
        try:
            args = json.loads(llamada["args"] or "{}")
        except json.JSONDecodeError:
            logger.warning("Argumentos no son JSON válido: %r", llamada["args"])
            return {"error": "Los argumentos no eran JSON válido. Reintenta."}, None
        return await runner.run(llamada["name"], args)

    def _build_messages(self, request: ChatRequest) -> list[dict]:
        """Antepone el prompt de sistema. El cliente no puede sobrescribirlo."""
        turns = [m.model_dump() for m in request.messages if m.role != "system"]
        bloques = (self._system_prompt, self._fecha(), self._vista(request.vista))
        sistema = "\n\n".join(b for b in bloques if b)
        return [{"role": "system", "content": sistema}, *turns]

    @staticmethod
    def _fecha() -> str:
        """El modelo no tiene reloj.

        Sin esto rellena el año con el de su entrenamiento y responde «agosto de
        2023» estando en 2026. Se calcula por petición, no al arrancar, para que un
        servidor de días no se quede viejo.
        """
        hoy = datetime.now(COLOMBIA).date()
        return (
            f"Hoy es {hoy.isoformat()}. Si el usuario nombra un mes sin año, se "
            f"refiere al del año en curso ({hoy.year}); tradúcelo a YYYY-MM antes "
            f"de llamar a una herramienta. Nunca supongas otro año."
        )

    @staticmethod
    def _vista(vista: VistaTablero | None) -> str:
        """Los filtros que el usuario tiene puestos.

        Sin esto el chat responde sobre todo el histórico mientras la persona mira
        un mes y una zona concretos: las dos cifras se contradicen y el chat pierde
        credibilidad aunque los números estén bien.
        """
        resumen = vista.resumen() if vista else ""
        if not resumen:
            return (
                "El usuario no tiene filtros puestos: está viendo todo el histórico.\n"
                "Al dar una cifra, di siempre sobre qué recorte la calculaste."
            )
        return (
            f"FILTROS ACTIVOS EN SU PANTALLA — {resumen}\n"
            "El servidor ya los aplica TODOS a cada consulta (lugar, técnicos, tipo de orden, actividad, "
            "contratista, estados visibles y periodo) cuando tú no pasas otro: no hace falta repetirlos, y el resultado trae `filtros_de_pantalla` con lo que aplicó. "
            "No preguntes qué recorte usar: responde con el de su pantalla y dilo. "
            "Si pide expresamente otro lugar, pásalo; si pide todo Cartagena o ignorar sus filtros, "
            "usa `sin_filtros_de_pantalla: true`. Si él dice «este barrio» o «aquí», se refiere a estos.\n"
            "Al dar una cifra, di siempre sobre qué recorte la calculaste; si por "
            "algún motivo respondes sobre un recorte distinto al de su pantalla, "
            "adviértelo en la misma frase."
        )

    @staticmethod
    def _translate(exc: Exception) -> OpenAIServiceError:
        """Convierte los errores del SDK en algo que el cliente pueda entender."""
        if isinstance(exc, RateLimitError):
            return OpenAIServiceError("OpenAI está limitando las peticiones.", 429)
        if isinstance(exc, APITimeoutError):
            return OpenAIServiceError("OpenAI tardó demasiado en responder.", 504)
        if isinstance(exc, APIConnectionError):
            return OpenAIServiceError("No se pudo conectar con OpenAI.", 502)
        if isinstance(exc, APIStatusError):
            # 401/403 aquí casi siempre es la API key: no lo reveles al cliente.
            logger.error("OpenAI respondió %s: %s", exc.status_code, exc.message)
            if exc.status_code in (401, 403):
                return OpenAIServiceError("La API no está bien configurada.", 500)
            return OpenAIServiceError("OpenAI rechazó la petición.", 502)

        logger.exception("Error inesperado llamando a OpenAI")
        return OpenAIServiceError("Error inesperado al consultar el modelo.", 502)


@lru_cache
def get_openai_service() -> OpenAIService:
    """Una instancia por proceso: comparte el pool HTTP entre peticiones."""
    client = AsyncOpenAI(
        api_key=settings.OPENAI_API_KEY,
        timeout=settings.OPENAI_TIMEOUT_SECONDS,
        max_retries=settings.OPENAI_MAX_RETRIES,
    )
    return OpenAIService(client, settings.OPENAI_MODEL, settings.OPENAI_SYSTEM_PROMPT)
