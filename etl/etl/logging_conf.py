"""Configuración de logging del ETL.

Reemplaza los `print(...)` sueltos del script original por un logger estándar,
con timestamp y nivel. En GitHub Actions esto se ve directo en los logs del job.
"""
from __future__ import annotations

import logging
import sys


def setup_logging(level: str = "INFO") -> logging.Logger:
    """Configura y devuelve el logger raíz del ETL.

    Args:
        level: nivel de logging ("DEBUG", "INFO", "WARNING", "ERROR").
    """
    logger = logging.getLogger("etl")
    if logger.handlers:  # evita duplicar handlers si se llama dos veces
        return logger

    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s | %(levelname)-7s | %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def get_logger() -> logging.Logger:
    """Devuelve el logger del ETL (ya configurado por `setup_logging`)."""
    return logging.getLogger("etl")
