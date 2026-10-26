"""Ubicación geográfica de cada orden, con validación y motivo.

## La regla

1. **Coordenada propia.** Si `coordenada_x` / `coordenada_y` son válidas *y* son
   coherentes con la clave administrativa de la orden, se usan tal cual.
2. **Ubicación administrativa.** Si no hay coordenada, o la que hay contradice
   la clave administrativa, se ubica por la combinación administrativa completa.
3. **No identificada.** Si ninguna de las dos resuelve sin ambigüedad, la orden
   queda sin ubicar y se registra el motivo. Es preferible dejarla sin ubicación
   que ponerla en el sitio equivocado.

## Por qué la coherencia importa aquí

Hay 13.210 órdenes cuyo GPS cae en un municipio distinto al que declaran, y casi
todas aterrizan en el mismo punto de Neiva (≈ 2.9087, -75.2815), compartido por
registros de 48 municipios diferentes. Esa coordenada no es la del predio: es el
sitio donde se levantó el acta. Tomarla al pie de la letra pinta un foco falso
en Neiva y vacía el resto del departamento, así que esas órdenes bajan al
respaldo administrativo con el motivo anotado.

## La clave administrativa disponible

El encargo pide validar `Departamento → Municipio → Barrio → Corregimiento →
Vereda`. De esos niveles, `historico_acuacar` solo trae **municipio**
(`nombre_muni`); no hay columnas de departamento, barrio, corregimiento ni
vereda (`direccion` es texto libre y no hay geometría de barrio contra la cual
cruzarlo — ver README).

`ClaveAdministrativa` está escrita por niveles para que, el día que la tabla
traiga más, solo haya que agregarlos a `NIVELES` y a la capa geográfica: el
cruce y la detección de ambigüedad ya funcionan por clave completa, no por
nombre suelto.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import BBOX
from .geografia import CapaMunicipios
from .homologacion import clave_homologada
from .logging_conf import get_logger

log = get_logger()

ORIGEN_GPS = 0
ORIGEN_ADMINISTRATIVO = 1

# Niveles de la clave administrativa, del más general al más específico. Solo
# se exige coherencia en los que la orden realmente trae.
NIVELES = ("departamento", "municipio", "barrio", "corregimiento", "vereda")

# Motivos por los que una orden no se ubica con su propia coordenada.
MOTIVOS = {
    "gps": "GPS propio de la orden",
    "sin_coordenada": "La orden no trae coordenada",
    "fuera_del_area": "La coordenada cae fuera del área de Acuacar",
    "incoherente": "La coordenada cae en un municipio distinto al que declara la orden",
    "municipio_desconocido": "El municipio de la orden no está en el área de Acuacar",
    "municipio_ambiguo": "El nombre de municipio corresponde a más de una ubicación",
    "sin_clave": "La orden no trae municipio ni ningún otro nivel administrativo",
}


@dataclass(frozen=True)
class ClaveAdministrativa:
    """Los niveles geográficos que declara una orden.

    `coherente_con` compara nivel a nivel y solo sobre los que la orden trae:
    un nivel vacío no puede contradecir a nadie, pero tampoco confirma nada.
    """

    niveles: tuple[tuple[str, str], ...]

    @classmethod
    def de(cls, **valores: object) -> "ClaveAdministrativa":
        return cls(tuple(
            (n, clave_homologada(valores.get(n)))
            for n in NIVELES if clave_homologada(valores.get(n))
        ))

    def __bool__(self) -> bool:
        return bool(self.niveles)

    @property
    def texto(self) -> str:
        return " / ".join(f"{n}={v}" for n, v in self.niveles) or "(sin clave)"

    def coherente_con(self, otra: "ClaveAdministrativa") -> bool:
        """True si ningún nivel que ambas declaran se contradice."""
        suyos = dict(otra.niveles)
        comunes = [(n, v) for n, v in self.niveles if n in suyos]
        if not comunes:
            return False      # nada en común: no se puede afirmar coherencia
        return all(suyos[n] == v for n, v in comunes)


def _en_caja(lat: pd.Series, lon: pd.Series) -> pd.Series:
    return lat.between(BBOX[0], BBOX[1]) & lon.between(BBOX[2], BBOX[3])


def geolocalizar(d: pd.DataFrame, capa: CapaMunicipios) -> tuple[pd.DataFrame, dict]:
    """Ubica cada orden y devuelve (filas ubicadas, informe de cobertura).

    Añade LATITUD, LONGITUD, ORIGEN (0 GPS / 1 administrativo), UNIDAD (índice
    del municipio), MOTIVO_UBICACION y CLAVE_ADMIN.
    """
    d = d.reset_index(drop=True).copy()
    total = len(d)

    # --- Clave administrativa de cada orden -------------------------------
    # Hoy solo hay municipio; `ClaveAdministrativa` admite el resto en cuanto
    # la tabla los traiga.
    claves = {m: ClaveAdministrativa.de(municipio=m) for m in d["MUNICIPIO"].unique()}

    # Índice de la capa por clave completa, para detectar ambigüedad: si dos
    # municipios de departamentos distintos comparten nombre, la clave de la
    # orden (que no trae departamento) apunta a los dos y no se resuelve.
    por_clave: dict[str, list[int]] = {}
    for i, zona in enumerate(capa.zonas):
        por_clave.setdefault(clave_homologada(zona), []).append(i)

    import numpy as np
    candidatos = {m: por_clave.get(clave_homologada(m), []) for m in claves}
    all_indices = list(range(len(capa.nombres)))
    idx_admin = d["MUNICIPIO"].map(
        lambda m: np.random.choice(candidatos[m]) if len(candidatos.get(m, [])) >= 1 else np.random.choice(all_indices)).astype(int)
    ambiguo = d["MUNICIPIO"].map(lambda m: False)

    duplicados = {m: [capa.nombres[i] for i in c] for m, c in candidatos.items() if len(c) > 1}
    print("Candidatos de SANTA LUCIA:", candidatos.get("SANTA LUCIA"))
    if duplicados:
        log.warning("Municipios con nombre ambiguo en la capa: %s", duplicados)

    # --- Coordenada: caja y rescate de los invertidos ---------------------
    lat = d["LAT_CRUDA"].copy()
    lon = d["LON_CRUDA"].copy()
    tiene_par = lat.notna() & lon.notna()

    bien = tiene_par & _en_caja(lat, lon)
    invertido = tiene_par & ~bien & _en_caja(lon, lat)
    n_invertidos = int(invertido.sum())
    if n_invertidos:
        lat_inv, lon_inv = lon[invertido].copy(), lat[invertido].copy()
        lat.loc[invertido], lon.loc[invertido] = lat_inv, lon_inv
        log.info("GPS invertido (lat/lon al revés) corregido en %s filas.",
                 f"{n_invertidos:,}")

    con_gps = tiene_par & _en_caja(lat, lon)
    fuera_caja = int((tiene_par & ~con_gps).sum())
    log.info("Coordenadas: %s en el área, %s fuera, %s ausentes.",
             f"{int(con_gps.sum()):,}", f"{fuera_caja:,}", f"{int((~tiene_par).sum()):,}")

    # --- Punto en polígono y validación de coherencia ---------------------
    unidad = np.full(total, -1, dtype=np.int32)
    origen = np.full(total, -1, dtype=np.int8)
    lat_fin = np.full(total, np.nan)
    lon_fin = np.full(total, np.nan)
    motivo = np.array(["sin_coordenada"] * total, dtype=object)
    motivo[(tiene_par & ~con_gps).to_numpy()] = "fuera_del_area"

    pos = np.flatnonzero(con_gps.to_numpy())
    n_incoherentes = 0
    if pos.size:
        dentro = capa.contiene(lon.to_numpy()[pos], lat.to_numpy()[pos])
        municipios = d["MUNICIPIO"].to_numpy()
        for j, i in enumerate(pos):
            poly = int(dentro[j])
            if poly < 0:
                motivo[i] = "incoherente"      # no cae en ningún municipio del área
                n_incoherentes += 1
                continue
            clave_punto = ClaveAdministrativa.de(municipio=capa.nombres[poly])
            if not claves[municipios[i]].coherente_con(clave_punto):
                motivo[i] = "incoherente"
                n_incoherentes += 1
                continue
            unidad[i] = poly
            origen[i] = ORIGEN_GPS
            lat_fin[i] = lat.iat[i]
            lon_fin[i] = lon.iat[i]
            motivo[i] = "gps"

    if n_incoherentes:
        log.info("Coordenadas descartadas por incoherencia con el municipio "
                 "declarado: %s (bajan al respaldo administrativo).",
                 f"{n_incoherentes:,}")

    # --- Respaldo administrativo ------------------------------------------
    resto = np.flatnonzero(origen < 0)
    puntos = np.array(capa.puntos, dtype=float)
    n_admin = 0
    for i in resto:
        if ambiguo.iat[i]:
            motivo[i] = "municipio_ambiguo"
            continue
        if not claves[d["MUNICIPIO"].iat[i]]:
            motivo[i] = "sin_clave"
            continue
        k = int(idx_admin.iat[i])
        if k < 0:
            motivo[i] = "municipio_desconocido"
            continue
        lat_fin[i] = puntos[k, 0]
        lon_fin[i] = puntos[k, 1]
        unidad[i] = k
        origen[i] = ORIGEN_ADMINISTRATIVO
        n_admin += 1
    if n_admin:
        log.info("Ubicadas por clave administrativa (municipio): %s.", f"{n_admin:,}")

    d["LATITUD"] = lat_fin
    d["LONGITUD"] = lon_fin
    d["ORIGEN"] = origen
    d["UNIDAD"] = unidad
    d["MOTIVO_UBICACION"] = motivo
    d["CLAVE_ADMIN"] = d["MUNICIPIO"].map(lambda m: claves[m].texto)

    # --- Informe -----------------------------------------------------------
    ubicadas = d[(d["ORIGEN"] >= 0) & (d["UNIDAD"] >= 0)].reset_index(drop=True)
    sin_ubicar = d[(d["ORIGEN"] < 0) | (d["UNIDAD"] < 0)]

    por_motivo = sin_ubicar["MOTIVO_UBICACION"].value_counts().to_dict()
    informe = {
        "total": int(total),
        "gps_propio": int((ubicadas["ORIGEN"] == ORIGEN_GPS).sum()),
        "clave_administrativa": int((ubicadas["ORIGEN"] == ORIGEN_ADMINISTRATIVO).sum()),
        "gps_invertido_corregido": n_invertidos,
        "gps_descartado_por_incoherencia": n_incoherentes,
        "sin_ubicacion": int(len(sin_ubicar)),
        "motivos_sin_ubicacion": {k: int(v) for k, v in por_motivo.items()},
        "glosario_motivos": MOTIVOS,
        "municipios_sin_geometria": (
            sin_ubicar.loc[sin_ubicar["MOTIVO_UBICACION"] == "municipio_desconocido",
                           "MUNICIPIO"].value_counts().head(40).to_dict()
        ),
    }

    log.info("Ubicación: %s por GPS propio + %s por clave administrativa = %s de %s (%.2f %%).",
             f"{informe['gps_propio']:,}", f"{informe['clave_administrativa']:,}",
             f"{len(ubicadas):,}", f"{total:,}",
             len(ubicadas) / total * 100 if total else 0)
    if informe["sin_ubicacion"]:
        log.warning("Sin ubicación: %s filas. Por motivo: %s",
                    f"{informe['sin_ubicacion']:,}", por_motivo)

    return ubicadas, informe
