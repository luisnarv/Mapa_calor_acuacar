#!/usr/bin/env python
"""Punto de entrada del ETL.  Uso:  python etl/run_etl.py [--log-level DEBUG]

Requiere DATABASE_URL (en .env). Escribe los JSON en web/public/scr/.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from etl import load_settings, run  # noqa: E402
from etl.logging_conf import setup_logging  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ETL de Acuacar: BD -> JSON del tablero.")
    parser.add_argument("--log-level", default=None, help="DEBUG | INFO | WARNING | ERROR")
    args = parser.parse_args(argv)
    try:
        settings = load_settings(log_level=args.log_level)
    except RuntimeError as exc:
        print(f"ERROR de configuración: {exc}", file=sys.stderr)
        return 1
    setup_logging(settings.log_level)
    try:
        run(settings)
    except Exception as exc:  # noqa: BLE001
        setup_logging(settings.log_level).error("ETL falló: %s", exc, exc_info=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
