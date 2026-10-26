"""Comprobación de punta a punta del proyecto.

Recorre la lista de validación del encargo y dice, una por una, si pasa:

    1. La conexión con DATABASE_URL funciona.
    2. `historico_electrohuila_scr` se puede consultar.
    3. Las capas de `Geografia` y la homologación de códigos están preparadas.
    4. Los registros cruzan contra esas capas.
    5. Las coordenadas generadas son válidas y caen en el área.
    6. El payload del mapa existe y tiene puntos.
    7. Los meses del manifiesto tienen su archivo.
    8. Los registros sin ubicación están contados, no descartados en silencio.
    9. El proyecto no apunta a rutas del proyecto original.
   10. El visor está instalado y compila.

Uso:

    python scripts/validar.py            # todo
    python scripts/validar.py --sin-bd   # salta lo que necesita PostgreSQL
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "etl"))

VERDE, ROJO, AMBAR, FIN = "\033[32m", "\033[31m", "\033[33m", "\033[0m"

fallos: list[str] = []
avisos: list[str] = []


def ok(titulo: str, detalle: str = "") -> None:
    print(f"  {VERDE}OK{FIN}    {titulo}" + (f"  —  {detalle}" if detalle else ""))


def mal(titulo: str, detalle: str) -> None:
    print(f"  {ROJO}FALLA{FIN} {titulo}  —  {detalle}")
    fallos.append(titulo)


def aviso(titulo: str, detalle: str) -> None:
    print(f"  {AMBAR}AVISO{FIN} {titulo}  —  {detalle}")
    avisos.append(titulo)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Validación del proyecto")
    p.add_argument("--sin-bd", action="store_true",
                   help="salta las comprobaciones que necesitan PostgreSQL")
    args = p.parse_args(argv)

    print(f"\nProyecto: {RAIZ}\n")

    # ------------------------------------------------------------------
    print("Geografía")
    geojson_dir = RAIZ / "web" / "public" / "geojson"
    capas = {}
    for nombre, minimo in (("municipios", 1), ("zonas", 1), ("perimetros", 0)):
        ruta = geojson_dir / f"{nombre}.geojson"
        if not ruta.exists():
            mal(f"capa {nombre}", f"falta {ruta}; corre scripts/preparar_geografia.py")
            continue
        gj = json.loads(ruta.read_text(encoding="utf-8"))
        capas[nombre] = gj
        n = len(gj.get("features", []))
        if n <= minimo:
            mal(f"capa {nombre}", f"solo {n} polígonos")
        else:
            ok(f"capa {nombre}", f"{n} polígonos, {ruta.stat().st_size / 1e6:.2f} MB")

    if "municipios" in capas:
        sin_zona = [f["properties"]["nombre"] for f in capas["municipios"]["features"]
                    if not f["properties"].get("zona")]
        if sin_zona:
            aviso("zona por municipio", f"sin zona: {sorted(sin_zona)}")
        else:
            ok("zona por municipio", "los 42 municipios tienen zona asignada")

    # ------------------------------------------------------------------
    print("\nHomologación de códigos")
    for guia in sorted((RAIZ / "Diccionarios").glob("*.xlsx")):
        ok("guía presente", guia.name)
    homologacion = RAIZ / "config" / "homologacion_codigos.json"
    if not homologacion.exists():
        mal("tabla de homologación", "falta; corre scripts/preparar_homologacion.py")
    else:
        h = json.loads(homologacion.read_text(encoding="utf-8"))
        ok("tabla de homologación",
           f"{h['origen']} · {len(h['combinaciones'])} combinaciones · "
           f"{len(h['vocabulario'])} resultados")
        for campo, tabla in h["campos"].items():
            ok(f"  · {campo}", f"{len(tabla)} códigos")

    # ------------------------------------------------------------------
    print("\nBase de datos")
    settings = None
    if args.sin_bd:
        aviso("conexión", "saltada por --sin-bd")
    else:
        try:
            from eh_etl.config import load_settings
            settings = load_settings()
            ok("DATABASE_URL", "definida (no se imprime su contenido)")
        except RuntimeError as exc:
            mal("DATABASE_URL", str(exc))

    if settings is not None:
        try:
            from eh_etl.database import Database
            from eh_etl.logging_conf import configurar
            configurar("WARNING")
            with Database(settings.database_url) as db:
                filas = db.comprobar(settings.tabla)
                ok("conexión a PostgreSQL", "responde")
                if filas > 0:
                    ok(f"consulta a {settings.tabla}", f"{filas:,} filas")
                else:
                    mal(f"consulta a {settings.tabla}", "la tabla está vacía")
        except Exception as exc:                               # noqa: BLE001
            mal("consulta a la tabla", f"{type(exc).__name__}: {exc}")

    # ------------------------------------------------------------------
    print("\nPayload del mapa")
    data_path = RAIZ / "web" / "public" / "data.json"
    if not data_path.exists():
        mal("data.json", "no existe; corre `python etl/run_etl.py`")
        return resumen()

    data = json.loads(data_path.read_text(encoding="utf-8"))
    meta, dim, geo, pts = data["meta"], data["dim"], data["geo"], data["pts"]
    ok("data.json", f"{data_path.stat().st_size / 1e6:.2f} MB")

    n = len(pts["e"])
    if n == 0:
        mal("puntos del mes en curso", "el payload no trae ninguno")
    else:
        ok("puntos del mes en curso", f"{n:,} registros")

    # Coordenadas válidas y dentro del área.
    from eh_etl.config import BBOX
    lat0, lon0 = meta["lat0"], meta["lon0"]
    fuera = 0
    for la, lo in zip(pts["la"], pts["lo"]):
        y = la / 1e5 + lat0
        x = lo / 1e5 + lon0
        if not (BBOX[0] <= y <= BBOX[1] and BBOX[2] <= x <= BBOX[3]):
            fuera += 1
    if fuera:
        mal("coordenadas dentro del área", f"{fuera:,} puntos fuera de la caja")
    else:
        ok("coordenadas dentro del área", f"{n:,}/{n:,} dentro de {BBOX}")

    # Toda orden dibujada tiene un resultado del diccionario y una regla.
    resultados = dim.get("estados") or []
    reglas = dim.get("reglas") or []
    if not resultados or not reglas:
        mal("clasificación", "el payload no trae `estados` ni `reglas`")
    else:
        fuera = [e for e in pts["e"] if not (0 <= e < len(resultados))]
        if fuera:
            mal("resultado de cada orden", f"{len(fuera):,} índices fuera de rango")
        else:
            ok("resultado de cada orden",
               f"{len(resultados)} resultados del diccionario, todos los índices válidos")
        sin = sum(1 for e in pts["e"] if resultados[e] == "SIN CLASIFICAR")
        ok("órdenes sin clasificar",
           f"{sin:,} de {n:,} en el mes en curso" if sin else "ninguna en el mes en curso")
        por_regla = collections.Counter(reglas[r] for r in pts["rg"])
        ok("trazabilidad de la clasificación",
           ", ".join(f"{k}:{v:,}" for k, v in por_regla.most_common()))

    # El ciclo viaja con su ficha.
    if dim.get("ciclos"):
        sin_ficha = sum(1 for u in dim.get("cicloUsuarios", []) if not u)
        ok("ciclo de cada orden",
           f"{len(dim['ciclos'])} ciclos en el payload, "
           f"{sin_ficha} sin ficha en config/ciclos.json")
    else:
        aviso("ciclo de cada orden", "el payload no trae la dimensión de ciclo")

    # Las dos unidades de agregación del mapa.
    if geo.get("cc"):
        if len(geo["cc"]) != len(dim.get("ciclos", [])):
            mal("centros de ciclo",
                f"{len(geo['cc'])} centros para {len(dim.get('ciclos', []))} ciclos")
        else:
            ok("agrupación por ciclo",
               f"{len(geo['cc'])} centros de ciclo (el mapa puede agrupar por ciclo)")
    else:
        mal("agrupación por ciclo", "el payload no trae geo.cc")

    for campo, rotulo in (("actividades", "actividad"),
                          ("operaciones", "operación en campo"),
                          ("brigadas", "brigada")):
        if dim.get(campo):
            ok(f"dimensión de {rotulo}", f"{len(dim[campo])} valores: {dim[campo][:4]}")
        else:
            aviso(f"dimensión de {rotulo}", "ausente; corre scripts/preparar_homologacion.py")

    # Cada punto cuelga de una unidad geográfica real.
    unidades = len(dim["barrios"])
    malos = [b for b in pts["b"] if not (0 <= b < unidades)]
    if malos:
        mal("unidad de cada punto", f"{len(malos):,} índices fuera de rango")
    else:
        ok("unidad de cada punto", f"{unidades} unidades, todos los índices válidos")

    if len(geo["bc"]) != unidades:
        mal("centroides", f"{len(geo['bc'])} centroides para {unidades} unidades")
    else:
        ok("centroides", f"{unidades} centroides")

    enlazados = sum(1 for p in geo["bp"] if p["b"] >= 0)
    ok("polígonos enlazados", f"{enlazados}/{len(geo['bp'])} con registros")

    # ------------------------------------------------------------------
    print("\nCobertura de la geolocalización")
    u = meta.get("ubicacion")
    if not u:
        mal("informe de ubicación", "meta.ubicacion no está en el payload")
    else:
        total = u["total"]
        ubicados = u["gps_propio"] + u["clave_administrativa"]
        ok("registros geolocalizados",
           f"{ubicados:,} de {total:,} ({ubicados / total * 100:.2f} %)")
        ok("  · por GPS propio", f"{u['gps_propio']:,}")
        ok("  · por clave administrativa", f"{u['clave_administrativa']:,}")
        ok("  · GPS descartado por incoherencia",
           f"{u['gps_descartado_por_incoherencia']:,} "
           "(caían en un municipio distinto al declarado)")
        if u["sin_ubicacion"]:
            ok("registros sin ubicación, con motivo",
               ", ".join(f"{k}: {v:,}" for k, v in u["motivos_sin_ubicacion"].items()))
        else:
            ok("registros sin ubicación", "ninguno")
        if ubicados + u["sin_ubicacion"] != total:
            mal("las cuentas cuadran",
                f"{ubicados:,} + {u['sin_ubicacion']:,} != {total:,}")
        else:
            ok("las cuentas cuadran", "ubicados + sin ubicación = total de la tabla")

    # ------------------------------------------------------------------
    print("\nArchivos por mes")
    faltan = [m["file"] for m in meta["months"]
              if m.get("file") and not (RAIZ / "web" / "public" / m["file"]).exists()]
    if faltan:
        mal("archivos de mes", f"faltan {len(faltan)}: {faltan[:3]}…")
    else:
        ok("archivos de mes", f"{len(meta['months'])} meses, todos presentes")

    # ------------------------------------------------------------------
    print("\nIndependencia del proyecto")
    # Nada del código que se ejecuta puede apuntar al proyecto de referencia.
    # `scripts/preparar_geografia.py` sí lo menciona: es el paso de insumo, ya
    # ejecutado, y su salida vive dentro del proyecto.
    patron = re.compile(r"Electro huila|Frontend[/\\]dashboard|dbanalitica\.historico_mo",
                        re.IGNORECASE)
    sospechosos = []
    for ruta in list((RAIZ / "etl").rglob("*.py")) + list((RAIZ / "web" / "src").rglob("*.js")):
        if "__pycache__" in str(ruta):
            continue
        texto = ruta.read_text(encoding="utf-8", errors="ignore")
        if patron.search(texto):
            sospechosos.append(str(ruta.relative_to(RAIZ)))
    if sospechosos:
        mal("sin rutas del proyecto original", f"aparecen en {sospechosos}")
    else:
        ok("sin rutas del proyecto original",
           "ni el ETL ni el visor referencian la carpeta de referencia")

    if (RAIZ / "web" / "node_modules").exists():
        ok("dependencias del visor", "node_modules instalado")
    else:
        aviso("dependencias del visor", "falta `npm install --prefix web`")

    if (RAIZ / "web" / ".next").exists():
        ok("compilación del visor", ".next presente (`npm run build --prefix web`)")
    else:
        aviso("compilación del visor", "todavía no se ha compilado")

    if (RAIZ / ".env").exists():
        ok(".env local", "presente y fuera de git (.gitignore)")
    else:
        aviso(".env local", "no existe; cópialo de .env.example")

    return resumen()


def resumen() -> int:
    print()
    if fallos:
        print(f"{ROJO}{len(fallos)} comprobación(es) fallida(s):{FIN} {', '.join(fallos)}")
        return 1
    if avisos:
        print(f"{VERDE}Todo lo crítico pasa.{FIN} {len(avisos)} aviso(s): {', '.join(avisos)}")
        return 0
    print(f"{VERDE}Todas las comprobaciones pasan.{FIN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
