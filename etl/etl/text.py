"""Utilidades de normalización de texto.

Tolerantes a tildes, mayúsculas, espacios y separadores.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

import pandas as pd

_SEPARADORES = ("/", "-", "_")


def norm(value: Any) -> str:
    """Normaliza un nombre: minúsculas, sin tildes, separadores a espacio.

    Ejemplo: ``"SUBACCIÓN/SUBANOMALÍA"`` -> ``"subaccion subanomalia"``.
    """
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value).strip().lower()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("utf-8")
    for sep in _SEPARADORES:
        text = text.replace(sep, " ")
    return " ".join(text.split())


def norm_dato(value: Any) -> str:
    """Normalización agresiva para cruces contra el maestro: solo letras y números.

    Repara además el *mojibake* típico (``Ã``/``Â``) de datos mal decodificados.
    """
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value)
    if "Ã" in text or "Â" in text:  # repara doble-decodificación latin-1/utf-8
        try:
            text = text.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", text)

