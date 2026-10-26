"""Logging estándar del ETL: un formato, configurable por nivel."""
from __future__ import annotations

import logging
import sys

NOMBRE = "eh_etl"


def configurar(nivel: str = "INFO") -> logging.Logger:
    log = logging.getLogger(NOMBRE)
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s",
                                         datefmt="%H:%M:%S"))
        log.addHandler(h)
    log.setLevel(getattr(logging, nivel.upper(), logging.INFO))
    log.propagate = False
    return log


def get_logger() -> logging.Logger:
    return logging.getLogger(NOMBRE)
