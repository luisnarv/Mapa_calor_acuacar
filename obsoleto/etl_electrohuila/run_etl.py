#!/usr/bin/env python
"""CLI del ETL: regenera el payload del mapa de calor.

    python run_etl.py                    # todos los meses de la tabla
    python run_etl.py --anio 2026        # solo 2026
    python run_etl.py --log-level DEBUG
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eh_etl import load_settings, run                 # noqa: E402
from eh_etl.logging_conf import configurar            # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="ETL del mapa de calor de Acuacar")
    p.add_argument("--anio", type=int, action="append", dest="anios",
                   help="limita la corrida a un año (se puede repetir)")
    p.add_argument("--log-level", default=None,
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = p.parse_args(argv)

    try:
        settings = load_settings(
            anios=tuple(args.anios) if args.anios else None,
            log_level=args.log_level,
        )
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    log = configurar(settings.log_level)
    try:
        run(settings)
    except RuntimeError as exc:
        log.error("%s", exc)
        return 1
    except Exception:                      # pragma: no cover
        log.exception("Fallo inesperado del ETL.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
