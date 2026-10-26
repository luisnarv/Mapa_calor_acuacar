"""Acceso de solo lectura a PostgreSQL."""
from __future__ import annotations

import pandas as pd
import psycopg2

from .logging_conf import get_logger

log = get_logger()


def fetch_ordenes(database_url: str, query: str) -> pd.DataFrame:
    """Trae las órdenes como DataFrame en una sesión de solo lectura."""
    log.info("Consultando la base de datos…")
    try:
        con = psycopg2.connect(database_url)
    except psycopg2.Error as exc:
        raise RuntimeError(f"No se pudo conectar a la base de datos: {exc}") from exc
    try:
        con.set_session(readonly=True, autocommit=True)
        with con.cursor() as cur:
            cur.execute(query)
            df = pd.DataFrame(cur.fetchall(), columns=[d[0] for d in cur.description])
    finally:
        con.close()
    log.info("Cargadas %s filas.", f"{len(df):,}")
    return df
