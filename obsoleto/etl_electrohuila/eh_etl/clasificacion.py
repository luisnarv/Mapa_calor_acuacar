"""Clasificación del resultado de cada orden, según el diccionario oficial.

La fuente es `config/homologacion_codigos.json`, que produce
`scripts/preparar_homologacion.py` a partir de
`Diccionario_codigos_acuacar.xlsx`. Aquí no se inventa ninguna
equivalencia: todo código, su significado y el resultado que asigna salen del
archivo, y lo que el archivo no cubre queda marcado como no clasificable.

## Cómo se resuelve

Seis reglas, en orden. La primera que aplica gana, y su nombre viaja con la
orden para que después se pueda rastrear por qué quedó como quedó.

| Regla | Qué mira | De dónde sale |
|---|---|---|
| `R1_combinacion`   | la terna exacta (causal, suspensión en, código) | hoja «Combinaciones» |
| `R2_estado`        | el Estado, cuando decide solo (`A` = orden sin ejecutar) | hoja «Códigos» |
| `R3_codigo`        | el código de observación, cuando decide solo | hoja «Códigos» |
| `R4_causal`        | la causal, cuando decide sola (`FP` = factura pagada) | hoja «Códigos» |
| `R5_suspension_en` | dónde se ejecutó, que manda cuando el código es ambiguo | hoja «Códigos» |
| `R6_sin_regla`     | nada decide: queda SIN CLASIFICAR, con el motivo | — |

`R1` va primero porque es la resolución explícita del diccionario para esa
terna; solo cede cuando la propia hoja dice «(varía por Estado)», que es
justamente lo que resuelve `R2`.

`R2` va antes que `R3` porque el diccionario marca `Estado = A` («Orden sin
ejecutar») como decisor único: si la orden no se ejecutó, da igual qué diga el
código de la visita.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .logging_conf import get_logger

log = get_logger()

SIN_CLASIFICAR = "SIN CLASIFICAR"

# Un resultado entre paréntesis en la hoja «Combinaciones» no es un resultado:
# es «esto lo decide el Estado» (la fila trae «(varía por Estado)»).
def _es_diferido(resultado: str) -> bool:
    return not resultado or resultado.startswith("(")


@dataclass(frozen=True)
class Veredicto:
    """El resultado de una orden y por qué quedó así."""

    resultado: str
    regla: str
    detalle: str

    @property
    def clasificada(self) -> bool:
        return self.resultado != SIN_CLASIFICAR


class Clasificador:
    """Resuelve el resultado de una orden a partir del diccionario."""

    def __init__(self, tabla: dict[str, Any]) -> None:
        self.origen = tabla.get("origen", "?")
        self.campos = tabla["campos"]
        self.vocabulario = list(tabla["vocabulario"])
        self.combinaciones = {
            (c["causal"], c["suspension_en"], c["observacion"]): c["resultado"]
            for c in tabla["combinaciones"]
        }
        self._obs = self.campos["observacion_suspension"]
        self._causal = self.campos["causal_suspension"]
        self._susp = self.campos["suspension_en"]
        self._estado = self.campos["estado"]

    @classmethod
    def desde(cls, path: Path) -> "Clasificador":
        if not path.exists():
            raise RuntimeError(
                f"Falta {path}. Corre antes `python scripts/preparar_homologacion.py`."
            )
        with open(path, encoding="utf-8") as fh:
            tabla = json.load(fh)
        c = cls(tabla)
        log.info("Diccionario %s: %d códigos de observación, %d combinaciones, "
                 "%d resultados posibles.",
                 c.origen, len(c._obs), len(c.combinaciones), len(c.vocabulario))
        return c

    # -- consulta de significados, para la trazabilidad --------------------

    def significado(self, campo: str, codigo: str) -> str:
        ficha = self.campos.get(campo, {}).get(codigo)
        return ficha["significado"] if ficha else "(no está en el diccionario)"

    def atributo(self, campo: str, codigo: str, nombre: str, vacio: str = "") -> str:
        """Un atributo de la guía de observaciones (operación, brigada, contexto)."""
        ficha = self.campos.get(campo, {}).get(codigo) or {}
        return ficha.get(nombre) or vacio

    # -- la resolución -----------------------------------------------------

    def resolver(self, causal: str, suspension_en: str, observacion: str,
                 estado: str) -> Veredicto:
        """Aplica las seis reglas y devuelve el resultado con su justificación."""
        causal = (causal or "").strip().upper()
        suspension_en = (suspension_en or "").strip().upper()
        observacion = (observacion or "").strip().upper()
        estado = (estado or "").strip().upper()

        if causal in ['ORDENES DE SUSPENSIÓN', 'RECONEXIÓN IMPAGADOS']:
            if estado == 'APROBADA':
                return Veredicto('SUSPENDIDO', 'R0_acuacar', 'estado=Aprobada')
            elif estado in ('IMPOSIBILIDAD', 'RECHAZADA MOVILIDAD'):
                return Veredicto('NO ES POSIBLE SUSPENDER', 'R0_acuacar', f'estado={estado}')
            else:
                return Veredicto('SIN INFORMACIÓN', 'R0_acuacar', f'estado={estado}')

        # R1 · la terna exacta del diccionario.
        r = self.combinaciones.get((causal, suspension_en, observacion))
        if r is not None and not _es_diferido(r):
            return Veredicto(r, "R1_combinacion",
                             f"terna {causal}/{suspension_en}/{observacion} "
                             f"está en el diccionario")

        # R2 · el Estado decide solo (hoy: A = orden sin ejecutar).
        ficha = self._estado.get(estado)
        if ficha and ficha["decide_solo"] and ficha["resultado"]:
            return Veredicto(ficha["resultado"], "R2_estado",
                             f"Estado {estado} = {ficha['significado']}")

        # R3 · el código de observación decide solo.
        ficha = self._obs.get(observacion)
        if ficha and ficha["decide_solo"] and ficha["resultado"]:
            return Veredicto(ficha["resultado"], "R3_codigo",
                             f"Observación {observacion} = {ficha['significado']}")

        # R4 · la causal decide sola (hoy: FP = factura pagada).
        ficha = self._causal.get(causal)
        if ficha and ficha["decide_solo"] and ficha["resultado"]:
            return Veredicto(ficha["resultado"], "R4_causal",
                             f"Causal {causal} = {ficha['significado']}")

        # R5 · el código es ambiguo, así que manda dónde se ejecutó.
        ficha = self._susp.get(suspension_en)
        if ficha and ficha["resultado"]:
            return Veredicto(ficha["resultado"], "R5_suspension_en",
                             f"Suspensión en {suspension_en} = {ficha['significado']}")

        # R6 · nada decide. Se deja constancia de qué faltaba.
        faltan = []
        if observacion and observacion not in self._obs:
            faltan.append(f"observación {observacion}")
        if causal and causal not in self._causal:
            faltan.append(f"causal {causal}")
        if suspension_en and suspension_en not in self._susp:
            faltan.append(f"suspensión en {suspension_en}")
        motivo = ("códigos fuera del diccionario: " + ", ".join(faltan)) if faltan \
            else "ningún campo decide el resultado"
        return Veredicto(SIN_CLASIFICAR, "R6_sin_regla", motivo)
