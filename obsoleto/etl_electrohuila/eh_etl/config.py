"""Configuración del ETL: conexión, rutas y consulta.

Las rutas se resuelven relativas a la raíz del proyecto (`Path(__file__)`), así
que el ETL corre igual en Windows y en Linux sin tocar nada.

La única credencial es `DATABASE_URL`, que se lee del entorno o de un `.env` en
la raíz del proyecto. Nunca se escribe en el código ni aparece en los logs.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# eh_etl/config.py -> etl/ -> raíz del proyecto.
ETL_ROOT: Path = Path(__file__).resolve().parents[1]
RAIZ: Path = ETL_ROOT.parent

load_dotenv(RAIZ / ".env")

SALIDA_POR_DEFECTO: Path = RAIZ / "web" / "public"
GEOJSON_POR_DEFECTO: Path = RAIZ / "web" / "public" / "geojson"
HOMOLOGACION_POR_DEFECTO: Path = RAIZ / "config" / "homologacion_codigos.json"
CICLOS_POR_DEFECTO: Path = RAIZ / "config" / "ciclos.json"

# Tabla de origen. Se deja configurable porque el nombre puede cambiar entre
# entornos; el valor por defecto es el que existe hoy en la base.
TABLA_POR_DEFECTO = "dbanalitica.historico_acuacar_scr"

# Caja geográfica del área de Acuacar (Cartagena + los municipios de Tolima,
# Cauca y Caquetá que atiende). Sale de los límites reales de
# `web/public/geojson/municipios.geojson`, con un margen de 0,1°.
# (lat_min, lat_max, lon_min, lon_max)
BBOX: tuple[float, float, float, float] = (0.44, 3.95, -76.73, -73.14)

# Origen para codificar coordenadas como enteros compactos (la/lo del JSON).
# Se elige por debajo del mínimo de la caja para que nunca salgan negativos.
LAT0: float = 0.0
LON0: float = -77.0

MESES_ES: tuple[str, ...] = (
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
)

# Solo las columnas que el mapa usa: bajar las 40 de la tabla costaría el doble
# de red para tirar la mitad.
COLUMNAS = (
    "numero_documento",
    "cuenta",
    "nombre_muni",
    "direccion",
    "ciclo",
    "codigo_ruta",
    "zona",
    "estrato",
    "clase_servicio",
    "ubicacion",
    "estado",
    "causal_suspension",
    "suspension_en",
    "observacion_suspension",
    "funcionario",
    "servicio",
    "fecha_generacion",
    "fecha_accion",
    "fecha_reconexion",
    "coordenada_x",
    "coordenada_y",
)


def consulta(tabla: str) -> str:
    """SELECT de las columnas que consume el ETL, con la fecha ya resuelta."""
    return f"""
    SELECT
      id::TEXT AS numero_documento,
      poliza::TEXT AS cuenta,
      zona::TEXT AS nombre_muni,
      direccion::TEXT AS direccion,
      NULL::TEXT AS ciclo,
      NULL::TEXT AS codigo_ruta,
      centro::TEXT AS zona,
      estrato::TEXT AS estrato,
      NULL::TEXT AS clase_servicio,
      NULL::TEXT AS ubicacion,
      estado::TEXT AS estado,
      proceso::TEXT AS causal_suspension,
      NULL::TEXT AS suspension_en,
      observacion::TEXT AS observacion_suspension,
      interventor::TEXT AS funcionario,
      NULL::TEXT AS servicio,
      fecha_cargue_bd AS fecha_generacion,
      fecha_apertura AS fecha_accion,
      NULL::TIMESTAMP AS fecha_reconexion,
      NULL::NUMERIC AS coordenada_x,
      NULL::NUMERIC AS coordenada_y,
      COALESCE(fecha_apertura, fecha_cargue_bd) AS fecha_ejecucion,
      'SCR' AS tipo_actividad
    FROM {tabla}
    """


@dataclass(frozen=True)
class Settings:
    """Parámetros de una corrida del ETL."""

    database_url: str
    tabla: str
    salida: Path
    geojson_dir: Path
    homologacion: Path
    ciclos: Path
    anios: tuple[int, ...] | None
    log_level: str

    @property
    def geo_municipios(self) -> Path:
        return self.geojson_dir / "municipios.geojson"

    @property
    def geo_zonas(self) -> Path:
        return self.geojson_dir / "zonas.geojson"

    @property
    def geo_perimetros(self) -> Path:
        return self.geojson_dir / "perimetros.geojson"


def load_settings(
    *,
    anios: tuple[int, ...] | None = None,
    log_level: str | None = None,
) -> Settings:
    """Construye `Settings` a partir del entorno.

    Raises:
        RuntimeError: si falta `DATABASE_URL`.
    """
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError(
            "Falta la variable de entorno DATABASE_URL. "
            "Cópiala de .env.example a .env y complétala."
        )

    return Settings(
        database_url=database_url,
        tabla=os.environ.get("EH_TABLA", "").strip() or TABLA_POR_DEFECTO,
        salida=_ruta("EH_OUTPUT_DIR", SALIDA_POR_DEFECTO),
        geojson_dir=_ruta("EH_GEOJSON_DIR", GEOJSON_POR_DEFECTO),
        homologacion=_ruta("EH_HOMOLOGACION", HOMOLOGACION_POR_DEFECTO),
        ciclos=_ruta("EH_CICLOS", CICLOS_POR_DEFECTO),
        anios=anios,
        log_level=(log_level or os.environ.get("EH_LOG_LEVEL", "INFO")).upper(),
    )


def _ruta(variable: str, por_defecto: Path) -> Path:
    valor = os.environ.get(variable, "").strip()
    return Path(valor).expanduser().resolve() if valor else por_defecto
