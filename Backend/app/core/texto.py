"""Normalización de texto.

ESPEJO de `etl/etl/text.py`, sin pandas (la API no lo necesita). Si cambias una,
cambia la otra: el backend compara nombres que el ETL ya normalizó.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

_SEPARADORES = ("/", "-", "_")


def norm(value: Any) -> str:
    """Minúsculas, sin tildes, separadores a espacio, espacios colapsados."""
    if value is None:
        return ""
    text = str(value).strip().lower()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("utf-8")
    for sep in _SEPARADORES:
        text = text.replace(sep, " ")
    return " ".join(text.split())


def norm_dato(value: Any) -> str:
    """Normalización agresiva para cruces: solo deja letras y números."""
    if value is None:
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
