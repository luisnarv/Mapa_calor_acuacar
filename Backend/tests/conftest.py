"""Datos sintéticos para las pruebas.

Las pruebas NUNCA leen `web/public/scr/`: el ETL lo regenera y las cifras cambiarían
solas. Aquí se arma un payload mínimo con el mismo formato y conteos conocidos a mano.
"""

import json
import os
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
# `Settings` exige la clave al importarse; ninguna prueba llama a OpenAI de verdad.
os.environ.setdefault("OPENAI_API_KEY", "sk-de-prueba")

BARRIOS = [
    "CARTAGENA DE INDIAS | ALBORNOZ (C15)",
    "CARTAGENA DE INDIAS | EL POZON (C08)",
    "CARTAGENA DE INDIAS | LA BOQUILLA (C01)",
    "CARTAGENA DE INDIAS | LA BOQUILLA (C02)",
    # Sin órdenes: solo existen en el catálogo, para probar cómo se resuelven sus nombres.
    "CARTAGENA DE INDIAS | OLAYA HERRERA (COM 5) (C07)",
    "CARTAGENA DE INDIAS | OLAYA HERRERA (COM 6) (C07)",
    "CARTAGENA DE INDIAS | OLAYA - SECTOR RAFAEL NUÑEZ (C06)",
]
TECNICOS = ["Ana Perez Lopez", "Luis Perez Mora", "Carlos Rojas"]
TIPOS = ["Ordenes de suspensión", "Reconexión Impagados"]
CAUSAS = ["Acceso o seguridad", "Efectiva", "Estado del servicio", "Oposición del usuario"]
CAUSA_CTRL = [1, 1, 0, 0]
TARIFAS = ["31 · RESIDENCIAL ESTRATO 3", "32 · RESIDENCIAL ESTRATO 3", "71 · COMERCIAL E INST.PROV."]

# (barrio, técnico, tipo, causa, estado 0 Efectiva / 2 Perdida, tarifa, minutos desde fecha_min)
# Agosto: 10 órdenes. Septiembre: 6 órdenes.
AGOSTO = [
    (0, 0, 0, 1, 0, 0, 10), (0, 0, 0, 1, 0, 0, 20), (0, 0, 0, 3, 2, 0, 30), (0, 1, 1, 0, 2, 1, 40),
    (1, 1, 0, 1, 0, 1, 50), (1, 1, 0, 1, 0, 2, 60), (1, 1, 1, 2, 2, 2, 70), (2, 2, 1, 1, 0, 0, 80),
    (3, 2, 1, 0, 2, 0, 90), (3, 2, 1, 1, 0, 0, 100),
]
SEPTIEMBRE = [
    (0, 0, 0, 1, 0, 0, 50_000), (0, 1, 0, 3, 2, 1, 50_010), (1, 1, 1, 1, 0, 1, 50_020),
    (2, 2, 0, 0, 2, 0, 50_030), (2, 2, 0, 1, 0, 0, 50_040), (3, 2, 1, 1, 0, 2, 50_050),
]

def _pts(filas):
    return {
        "la": [100_000 + i for i in range(len(filas))], "lo": [50_000 + i for i in range(len(filas))],
        "b": [f[0] for f in filas], "t": [f[1] for f in filas], "o": [f[2] for f in filas],
        "c": [f[3] for f in filas], "e": [f[4] for f in filas], "f": [f[5] for f in filas],
        "m": [f[6] for f in filas],
        "g": [0] * len(filas), "s": [0] * len(filas), "a": [f[2] for f in filas],
        "n": list(range(1, len(filas) + 1)), "nic": [str(1000 + i) for i in range(len(filas))],
    }


@pytest.fixture
def datos_dir(tmp_path: Path) -> Path:
    raiz = {
        "meta": {
            "total": len(SEPTIEMBRE), "total_all": len(AGOSTO) + len(SEPTIEMBRE),
            "fecha_min": "2026-08-10", "fecha_max": "2026-09-24", "lat0": 10.0, "lon0": -76.0,
            "generated": "2026-10-26",
            "months": [
                {"key": "2026-08", "label": "Agosto de 2026", "n": len(AGOSTO), "file": "data_2026-08.json"},
                {"key": "2026-09", "label": "Septiembre de 2026", "n": len(SEPTIEMBRE), "recent": True},
            ],
        },
        "dim": {
            "barrios": BARRIOS, "tecs": TECNICOS, "brigs": ["ISES"], "tipos": TIPOS, "causas": CAUSAS,
            "subs": ["SIN DATO"], "susps": ["SIN DATO"], "tarifas": TARIFAS, "acts": TIPOS,
            "munis": ["CARTAGENA DE INDIAS"], "zonas": ["C01", "C02", "C08", "C15", "C07", "C06"],
            "estados": ["Efectiva", "Fallida", "Perdida"],
            "causa_ctrl": CAUSA_CTRL, "causa_fam": ["acceso", "exito", "normativo", "seguridad"],
            "b_muni": [0] * 7, "b_zona": [3, 2, 0, 1, 4, 4, 5],
            # Corregimientos: La Boquilla (2 y 3) es rural; el resto es la cabecera urbana.
            "corrs": ["Cabecera municipal", "La Boquilla"], "b_corr": [0, 0, 1, 1, 0, 0, 0],
        },
        "geo": {"bc": [], "bp": [], "mp": [], "zp": [], "cp": [], "vp": []},
        "pts": _pts(SEPTIEMBRE),
    }
    (tmp_path / "data.json").write_text(json.dumps(raiz), encoding="utf-8")
    (tmp_path / "data_2026-08.json").write_text(json.dumps({"pts": _pts(AGOSTO)}), encoding="utf-8")
    return tmp_path
