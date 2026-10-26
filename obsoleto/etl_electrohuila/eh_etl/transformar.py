"""Campos derivados del histórico: resultado de la orden, etiquetas y fechas.

La clasificación del resultado NO se hace aquí: la resuelve `clasificacion.py`
contra el diccionario oficial. Este módulo se encarga de aplicarla fila por
fila, de guardar la trazabilidad (qué regla decidió y por qué) y de dejar las
demás columnas listas para el payload.

Todo vectorizado: las traducciones se calculan una vez por combinación distinta
y se propagan con `map`.
"""
from __future__ import annotations

import pandas as pd

from .clasificacion import Clasificador
from .homologacion import (
    ETIQUETAS_CLASE_SERVICIO,
    ETIQUETAS_UBICACION,
    con_significado,
    etiqueta,
    grupo_de,
)
from .logging_conf import get_logger

log = get_logger()

# Columnas que forman la clave de clasificación.
CLAVE_CLASIFICACION = (
    "causal_suspension", "suspension_en", "observacion_suspension", "estado",
)


def _por_unico(serie: pd.Series, fn) -> pd.Series:
    """Aplica `fn` una vez por valor distinto y lo propaga."""
    tabla = {v: fn(v) for v in pd.unique(serie)}
    return serie.map(tabla)


def _texto(serie: pd.Series) -> pd.Series:
    """Limpia una columna de texto: recorta y convierte los vacíos en None."""
    s = serie.astype("object").map(lambda v: v.strip() if isinstance(v, str) else v)
    return s.replace({"": None, "nan": None, "None": None, "NaT": None})


def _codigo(serie: pd.Series) -> pd.Series:
    """Normaliza un código a mayúsculas sin espacios; vacío -> ''."""
    return serie.fillna("").astype(str).str.strip().str.upper()


def enrich(df: pd.DataFrame, clasificador: Clasificador,
           ciclos: dict[str, dict] | None = None) -> pd.DataFrame:
    """Clasifica cada orden y deriva las columnas que consume el mapa.

    No descarta ninguna fila: quitar filas es trabajo de `geolocalizar`, que
    además lleva la cuenta de por qué se quedó cada una sin ubicación.
    """
    d = df.copy()

    for col in ("nombre_muni", "estado", "causal_suspension", "suspension_en",
                "observacion_suspension", "clase_servicio", "ubicacion",
                "funcionario", "cuenta", "direccion"):
        d[col] = _texto(d[col])

    for col in CLAVE_CLASIFICACION:
        d[f"_{col}"] = _codigo(d[col])

    # --- Clasificación del resultado --------------------------------------
    # Hay 422.727 filas pero solo unos cientos de combinaciones distintas de
    # los cuatro códigos: se resuelve una vez por combinación.
    clave = (d["_causal_suspension"] + "|" + d["_suspension_en"] + "|"
             + d["_observacion_suspension"] + "|" + d["_estado"])
    unicas = pd.unique(clave)
    veredictos = {}
    for k in unicas:
        causal, susp, obs, est = k.split("|")
        veredictos[k] = clasificador.resolver(causal, susp, obs, est)
    log.info("Clasificación: %s combinaciones distintas de códigos.", f"{len(unicas):,}")

    d["RESULTADO"] = d["causal_suspension"].fillna("DESCONOCIDO")
    from .homologacion import grupo_de
    d["REGLA"] = "R0_bypass"
    d["DETALLE_REGLA"] = "Bypass clasificacion para Acuacar"
    d["GRUPO"] = d["RESULTADO"].map(grupo_de)

    reparto = d["RESULTADO"].value_counts()
    for resultado, n in reparto.items():
        log.info("  %-26s %9s  %5.2f%%", resultado, f"{n:,}", n / len(d) * 100)
    sin = int((d["RESULTADO"] == "SIN CLASIFICAR").sum())
    if sin:
        log.warning("Sin clasificar: %s filas (%.2f %%). Motivos: %s",
                    f"{sin:,}", sin / len(d) * 100,
                    sorted(d.loc[d["RESULTADO"] == "SIN CLASIFICAR",
                                 "DETALLE_REGLA"].unique())[:4])

    # --- Fecha ------------------------------------------------------------
    d["FECHA"] = pd.to_datetime(d["fecha_ejecucion"], errors="coerce")
    log.info("Fechas válidas: %s de %s.",
             f"{int(d['FECHA'].notna().sum()):,}", f"{len(d):,}")

    # --- Dimensiones legibles --------------------------------------------
    # Los códigos de la visita se muestran con su significado oficial, que sale
    # del mismo diccionario que decidió el resultado.
    d["MUNICIPIO"] = d["nombre_muni"].fillna("SIN MUNICIPIO").str.upper(); 
    d["FUNCIONARIO"] = d["funcionario"].fillna("SIN DATO").astype(str)

    def _obs_rotulo(c: str) -> str:
        """'SY · SUSPENSION REALIZADA (retiro de material de gabinete)'.

        La connotación de brigada solo la traen cinco códigos; cuando está, dice
        con qué recurso y sobre qué material se ejecuta, que es lo que define la
        cuadrilla que se despacha.
        """
        base = con_significado(c, clasificador.significado("observacion_suspension", c))
        extra = clasificador.atributo("observacion_suspension", c, "connotacion")
        return f"{base} ({extra})" if extra else base

    d["OBSERVACION"] = _por_unico(d["_observacion_suspension"], _obs_rotulo)

    for col, campo, destino in (
        ("_causal_suspension", "causal_suspension", "CAUSAL"),
        ("_suspension_en", "suspension_en", "SUSPENSION_EN"),
        ("_estado", "estado", "ESTADO_ORDEN"),
    ):
        d[destino] = _por_unico(
            d[col],
            lambda c, campo=campo: con_significado(c, clasificador.significado(campo, c)),
        )

    # El ciclo es la única columna de la tabla que baja del municipio: describe
    # la sectorización de la operación. Su ficha (zona, usuarios, descripción)
    # sale de `config/ciclos.json`.
    fichas = ciclos or {}

    def _rotulo_ciclo(v: object) -> str:
        if pd.isna(v):
            return "SIN CICLO"
        n = str(int(v))
        desc = (fichas.get(n) or {}).get("descripcion") or ""
        return f"{n} · {desc}" if desc else n

    d["CICLO_NUM"] = pd.to_numeric(d["ciclo"], errors="coerce")
    d["CICLO"] = _por_unico(d["CICLO_NUM"], _rotulo_ciclo)
    con_ficha = d["CICLO_NUM"].map(lambda v: str(int(v)) in fichas if pd.notna(v) else False)
    log.info("Ciclo: %s con ficha, %s sin ella (de %s).",
             f"{int(con_ficha.sum()):,}", f"{int((~con_ficha).sum()):,}", f"{len(d):,}")

    # --- Actividad: suspensión o reconexión -------------------------------
    #
    # `historico_acuacar` es el plano de control de SUSPENSIONES: las
    # 422.727 filas nacen como orden de suspensión (todas traen causal y fecha
    # de generación). La reconexión no es otro tipo de orden, es el evento
    # posterior sobre la misma orden, y queda registrado en `fecha_reconexion`.
    #
    # La señal es inequívoca: `estado = 'R'` y `fecha_reconexion` no nula
    # coinciden en el 100 % de las 82.879 filas reconectadas, y solo 68 de las
    # 267.546 suspendidas tienen fecha sin estar en 'R'. Se usa la fecha, que
    # es el hecho, y se refuerza con los códigos de observación que la guía
    # marca como de reconexión (son pocos, pero confirman la visita).
    rec = pd.to_datetime(d["fecha_reconexion"], errors="coerce")
    cod_reconexion = _por_unico(
        d["_observacion_suspension"],
        lambda c: clasificador.atributo("observacion_suspension", c, "operacion") == "Reconexión",
    )
    d["RECONECTADA"] = rec.notna() | cod_reconexion
    d["ACTIVIDAD"] = d["tipo_actividad"].fillna("SIN ACTIVIDAD").astype(str)
    d["FECHA_RECONEXION"] = rec

    # Cuánto pasó entre la suspensión y la reconexión. Solo informativo, para
    # la ficha del registro; los negativos se descartan porque son datos
    # inconsistentes, no reconexiones anticipadas.
    dias = (rec - pd.to_datetime(d["fecha_accion"], errors="coerce")).dt.total_seconds() / 86400
    d["DIAS_RECONEXION"] = dias.where(dias >= 0).round(1)

    log.info("Actividad: %s", d["ACTIVIDAD"].value_counts().to_dict())

    # De la guía de observaciones: a qué operación pertenece el código de la
    # visita y con qué brigada se ejecuta. No intervienen en la clasificación;
    # son dos dimensiones más para filtrar y leer el mapa.
    d["OPERACION"] = _por_unico(
        d["_observacion_suspension"],
        lambda c: clasificador.atributo("observacion_suspension", c, "operacion",
                                        "SIN DEFINIR"))
    d["BRIGADA"] = _por_unico(
        d["_observacion_suspension"],
        lambda c: clasificador.atributo("observacion_suspension", c, "brigada",
                                        "SIN DATO"))
    log.info("Operación de la orden: %s",
             d["OPERACION"].value_counts().to_dict())

    d["CLASE_SERVICIO"] = _por_unico(d["clase_servicio"],
                                     lambda v: etiqueta(ETIQUETAS_CLASE_SERVICIO, v))
    d["UBICACION"] = _por_unico(d["ubicacion"], lambda v: etiqueta(ETIQUETAS_UBICACION, v))
    d["ESTRATO"] = d["estrato"].map(
        lambda v: f"Estrato {int(v)}" if pd.notna(v) else "SIN DATO")

    # --- Coordenadas crudas ----------------------------------------------
    # `coordenada_x` guarda la LATITUD y `coordenada_y` la LONGITUD (al revés
    # de lo que sugiere el nombre): en los datos, x va de 0,5 a 3,9 y y de -76,7
    # a -73,2, y el Cartagena está en 1,5–3,9 N y 74,4–76,6 O.
    d["LAT_CRUDA"] = pd.to_numeric(d["coordenada_x"], errors="coerce")
    d["LON_CRUDA"] = pd.to_numeric(d["coordenada_y"], errors="coerce")

    # --- Duplicados por documento ----------------------------------------
    dup = int(d["numero_documento"].duplicated().sum())
    if dup:
        d = (d.sort_values("FECHA")
               .drop_duplicates("numero_documento", keep="last")
               .reset_index(drop=True))
        log.info("Duplicados: %s documentos repetidos, se conserva el más reciente.",
                 f"{dup:,}")

    d["DOCUMENTO"] = pd.to_numeric(d["numero_documento"], errors="coerce").fillna(0).astype("int64")
    d["CUENTA"] = d["cuenta"].fillna("").astype(str)

    return d
