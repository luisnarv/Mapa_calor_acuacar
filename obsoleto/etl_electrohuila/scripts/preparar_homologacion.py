"""Convierte las guías de `Diccionarios/` en la tabla de homologación.

Paso de UNA sola vez, como `preparar_geografia.py`: su salida
(`config/homologacion_codigos.json`) queda dentro del proyecto y el ETL ya no
necesita los Excel ni openpyxl en tiempo de ejecución. Se vuelve a correr solo
si ElectroHuila actualiza las guías.

Son dos archivos y se complementan:

* **`Diccionario_codigos_electrohuila.xlsx`** — dice **qué resultado** asigna
  cada código. Es la fuente de la clasificación.
* **`observaciones*.xlsx`** — dice **qué es** cada código: a qué operación
  pertenece (suspensión o reconexión), con qué brigada se ejecuta, si se usa en
  cartera y el contexto operativo de campo. No cambia ningún resultado; agrega
  las descripciones y dos dimensiones nuevas al mapa.

El primero trae dos hojas y las dos se usan:

* **`Códigos`** — un código por fila, con la columna a la que pertenece, su
  significado oficial, el resultado que asigna y si decide por sí solo. De aquí
  sale la regla general.
* **`Combinaciones`** — 147 ternas (causal, suspensión en, código) ya resueltas
  por quien armó el diccionario, con cuántas actas respaldan cada una. De aquí
  sale la tabla exacta, que manda sobre la regla general.

No se inventa ninguna equivalencia: todo lo que escribe este script sale del
archivo. Lo que el archivo no cubre queda marcado como tal y lo resuelve la
regla general en `eh_etl/clasificacion.py`.
"""
from __future__ import annotations

import collections
import json
import os
import sys
from pathlib import Path

import openpyxl

RAIZ = Path(__file__).resolve().parents[1]
SALIDA = RAIZ / "config" / "homologacion_codigos.json"
DICCIONARIOS = RAIZ / "Diccionarios"
DICCIONARIO_POR_DEFECTO = DICCIONARIOS / "Diccionario_codigos_electrohuila.xlsx"

# Connotaciones para asignación de brigadas, entregadas por ElectroHuila el
# 2026-10-05. Describen con qué recurso y sobre qué material se ejecuta cada
# código, que es lo que define la brigada que se despacha.
#
# Contrastadas contra los datos: `MR` sale en gabinete en el 97 % de sus actas,
# así que la connotación afina lo que decía la guía. `SY` es la excepción — la
# nota dice «gabinete», pero en los datos solo el 36 % de sus actas lo son y el
# 64 % van en pin de corte, así que su texto nombra los dos sitios.
CONNOTACION_BRIGADA = {
    "MD": "Doble moto",
    "SM": "Retiro de material en camioneta",
    "SY": "Retiro de material de gabinete o pin de corte",
    "MR": "Retiro de material en gabinete",
    "SN": "Sin retiro de material, en camioneta",
}

# `SE USA EN` de la guía de observaciones -> a qué operación pertenece el código.
# Solo se traduce lo que el texto dice sin ambigüedad; el resto queda vacío.
OPERACION_POR_USO = {
    "SUSPENSIONES": "Suspensión",
    "RECONEXIONES": "Reconexión",
    "EN 2, SUS Y RECO": "Suspensión y reconexión",
    "NO SE USA": "No se usa",
    "SE USA LA AV, ESTA NO": "No se usa",
}

# Nombre de la hoja -> cómo lo llama el ETL.
COLUMNA_A_CAMPO = {
    "Observacion Suspension": "observacion_suspension",
    "Causal Suspension": "causal_suspension",
    "Suspension En": "suspension_en",
    "Estado": "estado",
}

# Un resultado que empieza con raya larga no es un resultado: es «no decide».
RAYAS = ("—", "–", "-", "")


def texto(v: object) -> str:
    return "" if v is None else str(v).strip()


def codigo(v: object) -> str:
    """Normaliza un código: mayúsculas y sin espacios. '0' sigue siendo '0'."""
    return texto(v).upper()


def resultado_de(v: object) -> str | None:
    """El resultado que asigna un código, o None si el código no decide."""
    t = texto(v)
    return None if (not t or t.startswith(RAYAS[:3])) else t


def decide_solo(v: object) -> bool:
    """`¿Decide solo?` = Sí. 'Solo si el código es ambiguo' NO decide solo."""
    return texto(v).lower().startswith("s") and "solo si" not in texto(v).lower()


def main(argv: list[str] | None = None) -> int:
    ruta = Path(os.environ.get("EH_DICCIONARIO", "").strip() or DICCIONARIO_POR_DEFECTO)
    if not ruta.exists():
        print(f"No encuentro el diccionario: {ruta}\n"
              f"Defínelo con la variable EH_DICCIONARIO.", file=sys.stderr)
        return 2

    print(f"Diccionario: {ruta.name}")
    wb = openpyxl.load_workbook(ruta, read_only=True, data_only=True)

    # ---- Hoja «Códigos»: la regla general --------------------------------
    hoja = wb["Códigos"]
    filas = list(hoja.iter_rows(values_only=True))
    cab = [texto(c) for c in filas[0]]
    campos: dict[str, dict[str, dict]] = {c: {} for c in COLUMNA_A_CAMPO.values()}
    sin_reconocer: set[str] = set()

    for fila in filas[1:]:
        if not fila or not any(fila):
            continue
        d = dict(zip(cab, fila))
        columna = texto(d.get("Columna"))
        campo = COLUMNA_A_CAMPO.get(columna)
        if campo is None:
            sin_reconocer.add(columna)
            continue
        cod = codigo(d.get("Código"))
        if not cod:
            continue
        campos[campo][cod] = {
            "significado": texto(d.get("Significado")),
            "resultado": resultado_de(d.get("Resultado que asigna")),
            "decide_solo": decide_solo(d.get("¿Decide solo?")),
            "actas_diccionario": int(d.get("Actas en la base") or 0),
        }

    if sin_reconocer:
        print(f"  AVISO · columnas del Excel no reconocidas: {sorted(sin_reconocer)}")

    for campo, tabla in campos.items():
        solos = sum(1 for v in tabla.values() if v["decide_solo"])
        print(f"  {campo:24} {len(tabla):3} códigos · {solos} deciden por sí solos")

    # ---- Guía de observaciones: qué ES cada código ------------------------
    guias = sorted(DICCIONARIOS.glob("observaciones*.xlsx"))
    enriquecidos = 0
    for guia in guias:
        wb2 = openpyxl.load_workbook(guia, read_only=True, data_only=True)
        hoja2 = wb2[wb2.sheetnames[0]]
        filas2 = list(hoja2.iter_rows(values_only=True))
        cab2 = [texto(c) for c in filas2[0]]
        for fila in filas2[1:]:
            if not fila or not any(fila):
                continue
            d = dict(zip(cab2, fila))
            cod = codigo(d.get("OBS"))
            if not cod:
                continue
            uso = texto(d.get("SE USA EN")).upper()
            ficha = campos["observacion_suspension"].setdefault(cod, {
                "significado": texto(d.get("Descripción")),
                "resultado": None,
                "decide_solo": False,
                "actas_diccionario": 0,
            })
            if not ficha.get("significado") or ficha["significado"].startswith("("):
                ficha["significado"] = texto(d.get("Descripción"))
            ficha["operacion"] = OPERACION_POR_USO.get(uso, "")
            ficha["brigada"] = texto(d.get("BRIGADA")).upper()
            ficha["uso_cartera"] = texto(d.get("USO EN CARTERA")).upper().startswith("SI")
            contexto = texto(d.get("Contexto Operativo y Observación de Campo"))
            ficha["contexto"] = "" if contexto in ("?", "") else contexto
            if cod in CONNOTACION_BRIGADA:
                ficha["connotacion"] = CONNOTACION_BRIGADA[cod]
            enriquecidos += 1
        wb2.close()
        print(f"  {guia.name}: {enriquecidos} códigos con operación y brigada")
    if not guias:
        print(f"  AVISO · no hay observaciones*.xlsx en {DICCIONARIOS.name}; "
              "los códigos quedan sin operación ni brigada.")

    # ---- Hoja «Combinaciones»: la tabla exacta ---------------------------
    hoja = wb["Combinaciones"]
    filas = list(hoja.iter_rows(values_only=True))
    cab = [texto(c) for c in filas[0]]
    combinaciones: list[dict] = []
    for fila in filas[1:]:
        if not fila or not any(fila):
            continue
        d = dict(zip(cab, fila))
        combinaciones.append({
            "causal": codigo(d.get("causal")),
            "suspension_en": codigo(d.get("susp_en")),
            "observacion": codigo(d.get("cod")),
            "resultado": texto(d.get("resultado_por_campos")),
            "actas_diccionario": int(d.get("actas") or 0),
            # Qué decía el texto libre del acta y si coincidía: no se usa para
            # clasificar, pero deja ver dónde el diccionario y el acta discrepan.
            "resultado_texto": texto(d.get("resultado_texto_mayoritario")),
            "acuerdo_pct": d.get("acuerdo_%"),
            "coincide_con_texto": bool(d.get("coincide")),
        })
    wb.close()

    vocabulario = sorted({c["resultado"] for c in combinaciones
                          if not c["resultado"].startswith("(")}
                         | {v["resultado"] for t in campos.values() for v in t.values()
                            if v["resultado"]})
    depende_estado = [c for c in combinaciones if c["resultado"].startswith("(")]

    print(f"  combinaciones            {len(combinaciones):3} ternas "
          f"({len(depende_estado)} se resuelven por Estado)")
    print(f"\nVocabulario de resultados ({len(vocabulario)}):")
    for v in vocabulario:
        print(f"  · {v}")

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8") as fh:
        json.dump({
            "origen": ruta.name,
            "campos": campos,
            "combinaciones": combinaciones,
            "vocabulario": vocabulario,
        }, fh, ensure_ascii=False, indent=1)
    print(f"\n-> {SALIDA.relative_to(RAIZ)} ({SALIDA.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
