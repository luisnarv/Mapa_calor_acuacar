"""Acceso de solo lectura a PostgreSQL.

`DATABASE_URL` admite las dos formas que usa la operación: la URI
(`postgresql://usuario:clave@host:5432/base`) y la cadena de palabras clave de
libpq (`host=... port=5432 dbname=... user=... password=...`). psycopg2 acepta
ambas sin tocarlas, así que no hay que reescribir la variable según el entorno.
"""
from __future__ import annotations

from types import TracebackType

import pandas as pd
import psycopg2

from .logging_conf import get_logger

log = get_logger()


class Database:
    """Conexión al histórico. Context manager: cierra pase lo que pase."""

    def __init__(self, database_url: str) -> None:
        self._url = database_url
        self._con = None

    def __enter__(self) -> "Database":
        try:
            self._con = psycopg2.connect(self._url)
        except psycopg2.Error as exc:  # pragma: no cover - depende del entorno
            raise RuntimeError(f"No se pudo conectar a PostgreSQL: {exc}") from exc
        self._con.set_session(readonly=True, autocommit=True)
        log.info("Conectado a PostgreSQL.")
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None,
                 tb: TracebackType | None) -> None:
        if self._con is not None:
            self._con.close()
            log.info("Conexión cerrada.")

    def fetch(self, sql: str) -> pd.DataFrame:
        """Trae el histórico completo como DataFrame.

        Se arma con un cursor de psycopg2 en vez de `pandas.read_sql_query`
        para no arrastrar SQLAlchemy solo por una consulta de lectura (pandas
        avisa de eso desde la 2.0).
        """
        if self._con is None:
            raise RuntimeError("La conexión no está abierta.")
        with self._con.cursor() as cur:
            cur.execute(sql)
            columnas = [c.name for c in cur.description]
            filas = cur.fetchall()
        df = pd.DataFrame(filas, columns=columnas)
        log.info("Descargadas %s filas x %d columnas.", f"{len(df):,}", df.shape[1])
        return df

    def comprobar(self, tabla: str) -> int:
        """Cuenta las filas de la tabla: valida de un golpe conexión y permisos."""
        if self._con is None:
            raise RuntimeError("La conexión no está abierta.")
        with self._con.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) FROM {tabla}")
            return int(cur.fetchone()[0])
