"""Configuración del ETL: conexión, rutas y consulta.

Las rutas son relativas a la raíz del proyecto, así que corre igual en Windows y
Linux. La única credencial es `DATABASE_URL` (entorno o `.env`); nunca va en el
código ni en los logs.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ETL_ROOT: Path = Path(__file__).resolve().parents[1]
RAIZ: Path = ETL_ROOT.parent

load_dotenv(RAIZ / ".env")

SALIDA_POR_DEFECTO: Path = RAIZ / "web" / "public" / "scr"
GEOJSON_POR_DEFECTO: Path = RAIZ / "web" / "public" / "geojson"
# código de tarifa -> descripción, de la hoja TARIFAS de `Geo/Cartagena/TARIFA Y ZONAS.xlsx`.
TARIFAS_JSON: Path = RAIZ / "config" / "tarifas.json"

TABLA = "dbanalitica.historico_acuacar_scr"

# Caja de Cartagena: un GPS válido del planeta puede no serlo de la ciudad.
# (lat_min, lat_max, lon_min, lon_max)
BBOX: tuple[float, float, float, float] = (10.0, 10.8, -75.9, -75.2)

# Origen para codificar coordenadas como enteros compactos (la/lo del JSON).
LAT0: float = 10.0
LON0: float = -76.0

MESES_ES: tuple[str, ...] = (
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
)

# Alias a los nombres que el resto del ETL espera (los mismos del ETL de Aire, para que
# el tablero sea idéntico). El mapeo está justificado en `transform.py`.
QUERY_HISTORICO: str = f"""
    SELECT
      zona AS "ZONA",
      id_orden AS "ORDEN",
      poliza AS "NIC",
      direccion AS "DIRECCION",
      tarifa::text AS "TARIFA",
      brigada_movilidad AS "TECNICO",
      proceso AS "TIPO OS",
      contratista_desc AS "TIPO BRIGADA",
      causal_no_efectiva AS "ACCION",
      tipo_imposibilidad AS "SUBACCION/SUBANOMALIA",
      efectividad AS "EFECTIVIDAD",
      COALESCE(fecha_finalizacion, fecha_imposibilidad, fecha_apertura) AS "FECHA_CIERRE",
      observacion AS "OBSERVACION",
      latitud AS "LATITUD",
      longitud AS "LONGITUD"
    FROM {TABLA}
"""


@dataclass(frozen=True)
class Settings:
    """Parámetros de una corrida del ETL."""

    database_url: str
    public_dir: Path
    geojson_dir: Path
    log_level: str = "INFO"

    @property
    def geo_barrios(self) -> Path:
        return self.geojson_dir / "barrios.geojson"

    @property
    def geo_municipios(self) -> Path:
        return self.geojson_dir / "municipios.geojson"

    @property
    def geo_zonas(self) -> Path:
        return self.geojson_dir / "zonas.geojson"

    @property
    def geo_corregimientos(self) -> Path:
        return self.geojson_dir / "corregimientos.geojson"

    @property
    def geo_veredas(self) -> Path:
        return self.geojson_dir / "veredas.geojson"


def load_settings(*, log_level: str | None = None) -> Settings:
    """Construye `Settings` a partir del entorno.

    Raises:
        RuntimeError: si falta `DATABASE_URL`.
    """
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("Falta DATABASE_URL: defínela en .env (ver .env.example).")
    return Settings(
        database_url=database_url,
        public_dir=_ruta("ETL_OUTPUT_DIR", SALIDA_POR_DEFECTO),
        geojson_dir=_ruta("ETL_GEOJSON_DIR", GEOJSON_POR_DEFECTO),
        log_level=(log_level or os.environ.get("ETL_LOG_LEVEL", "INFO")).upper(),
    )


def _ruta(variable: str, por_defecto: Path) -> Path:
    valor = os.environ.get(variable, "").strip()
    return Path(valor).expanduser().resolve() if valor else por_defecto
