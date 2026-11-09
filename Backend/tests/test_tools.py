"""Las herramientas sobre un payload sintético con conteos conocidos a mano.

Agosto + septiembre = 16 órdenes: 10 efectivas y 6 perdidas, de las cuales 3 son por causas
no controlables. Efectividad cruda 10/16 = 62,5 %; ajustada 10/(16-3) = 76,9 %.
"""

import asyncio

import pytest

from app.schemas.chat import VistaTablero
from app.services.metrics_service import MetricsService
from app.services.tools import NOMBRES_DE_HERRAMIENTAS, TOOLS, ToolRunner, _zona, expandir_meses


def correr(runner: ToolRunner, nombre: str, **args):
    return asyncio.run(runner.run(nombre, args))


@pytest.fixture
def runner(datos_dir) -> ToolRunner:
    return ToolRunner(MetricsService(datos_dir))


def test_las_herramientas_publicadas_son_las_que_el_runner_implementa(runner):
    publicadas = {t["function"]["name"] for t in TOOLS}
    assert publicadas == NOMBRES_DE_HERRAMIENTAS
    assert all(hasattr(runner, f"_{n}") for n in publicadas)


def test_efectividad_total_da_las_dos_cifras(runner):
    resultado, _ = correr(runner, "efectividad", mes="todo")
    m = resultado["metricas"]
    assert (m["tot"], m["ef"], m["pe"], m["noctrl"]) == (16, 10, 6, 3)
    assert (m["ef_pct"], m["ef_adj"]) == (62.5, 76.9)
    assert "fa" not in m, "Acuacar no tiene fallidas"
    assert resultado["datos_hasta"] == "2026-09-24"


def test_septiembre_se_avisa_incompleto(runner):
    resultado, _ = correr(runner, "efectividad", mes="2026-09")
    assert "incompleto" in resultado["nota"]
    assert resultado["metricas"]["tot"] == 6


def test_zona_se_acepta_escrita_de_varias_formas(runner):
    assert _zona("zona 15") == _zona("c15") == _zona("C015") == "C15"
    a, _ = correr(runner, "efectividad", mes="todo", zona="zona 15")
    b, _ = correr(runner, "efectividad", mes="todo", zona="C15")
    assert a["metricas"] == b["metricas"]
    assert a["metricas"]["tot"] == 6  # el barrio 0 vive en la zona C15


def test_un_barrio_en_dos_zonas_se_suma(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", barrio="La Boquilla")
    assert resultado["metricas"]["tot"] == 6
    assert len(filtro.barrios) == 2
    assert {d["nombre"]: d["tot"] for d in resultado["detalle_por_zona"]} == {
        "LA BOQUILLA (C01)": 3, "LA BOQUILLA (C02)": 3}
    assert "UN solo barrio" in resultado["nota_agrupacion"]


def test_la_clave_completa_de_un_barrio_apunta_a_una_sola_zona(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", barrio="CARTAGENA DE INDIAS | LA BOQUILLA (C01)")
    assert resultado["metricas"]["tot"] == 3
    assert filtro.barrio == "CARTAGENA DE INDIAS | LA BOQUILLA (C01)"


def test_barrio_inexistente_vuelve_como_dato(runner):
    resultado, filtro = correr(runner, "efectividad", barrio="No Existe")
    assert resultado["error"] == "barrio_no_encontrado"
    assert filtro is None


def test_estrato_suma_sus_codigos_de_tarifa(runner):
    resultado, _ = correr(runner, "efectividad", mes="todo", tarifa="estrato 3")
    assert resultado["metricas"]["tot"] == 13  # tarifas 31 y 32; la 71 (comercial) son 3
    unico, _ = correr(runner, "efectividad", mes="todo", tarifa="31")
    assert unico["metricas"]["tot"] == 9


def test_tipo_de_orden_por_una_palabra_y_queda_en_el_filtro_del_mapa(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", tipo_os="reconexion")
    assert "Reconexión Impagados" in resultado["base"]
    assert filtro.tipo_os == "Reconexión Impagados"


def test_filtro_de_catalogo_que_no_resuelve_no_devuelve_el_total(runner):
    resultado, _ = correr(runner, "efectividad", zona="C99")
    assert resultado["error"] == "filtro_no_reconocido"
    assert "C15" in resultado["valores_validos"]


def test_periodo_sin_datos_no_cae_al_historico(runner):
    resultado, _ = correr(runner, "efectividad", mes="2025-01")
    assert resultado["error"] == "periodo_sin_datos"
    assert resultado["meses_con_datos"] == ["2026-09", "2026-08"]


def test_expandir_meses_acepta_anio_y_todo():
    disponibles = ["2026-09", "2026-08"]
    assert expandir_meses("2026", disponibles) == ["2026-08", "2026-09"]
    assert expandir_meses("todo", disponibles) == ["2026-08", "2026-09"]
    assert expandir_meses(None, disponibles) is None


def test_ranking_por_perdidas_deja_primero_al_que_mas_pierde(runner):
    resultado, _ = correr(runner, "ranking", dimension="tecnico", ordenar_por="perdidas",
                          orden="mas", mes="todo", min_ordenes=1)
    perdidas = [f["pe"] for f in resultado["filas"]]
    assert perdidas == sorted(perdidas, reverse=True)
    assert sum(perdidas) == 6


def test_ranking_marca_en_el_mapa_los_barrios_nombrados(runner):
    resultado, filtro = correr(runner, "ranking", dimension="barrio", mes="todo",
                               min_ordenes=1, limite=2, peores=True)
    assert len(resultado["filas"]) == 2
    assert filtro.barrios is not None and len(filtro.barrios) == 2


def test_ranking_de_un_tecnico_lo_deja_elegido(runner):
    _, filtro = correr(runner, "ranking", dimension="tecnico", mes="todo", min_ordenes=1, limite=1)
    assert len(filtro.tecnicos) == 1


def test_tecnico_ambiguo_pide_elegir(runner):
    resultado, _ = correr(runner, "efectividad", mes="todo", tecnico="Perez")
    assert resultado["error"] == "filtro_no_reconocido"
    assert set(resultado["valores_validos"]) == {"Ana Perez Lopez", "Luis Perez Mora"}


def test_tecnico_por_nombre_parcial_en_cualquier_orden(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", tecnico="lopez ana")
    assert resultado["metricas"]["tot"] == 4
    assert filtro.tecnicos == ["Ana Perez Lopez"]


def test_causas_marcan_cuales_son_controlables(runner):
    resultado, _ = correr(runner, "causas_no_efectivas", mes="todo")
    por_causa = {c["causa"]: c for c in resultado["causas"]}
    assert por_causa["Oposición del usuario"]["controlable"] is False
    assert por_causa["Acceso o seguridad"]["controlable"] is True
    assert sum(c["n"] for c in resultado["causas"]) == 6


def test_comparar_periodos_da_agosto_contra_septiembre_por_defecto(runner):
    resultado, _ = correr(runner, "comparar_periodos")
    assert (resultado["periodo_a"], resultado["periodo_b"]) == ("2026-08", "2026-09")
    assert (resultado["total"]["tot_a"], resultado["total"]["tot_b"]) == (10, 6)


def test_serie_mensual_trae_un_punto_por_mes(runner):
    resultado, _ = correr(runner, "serie_mensual")
    assert [f["mes"] for f in resultado["serie"]] == ["2026-08", "2026-09"]


def test_ordenes_de_tecnico_lista_y_enciende_los_puntos(runner):
    resultado, filtro = correr(runner, "ordenes_de_tecnico", tecnico="Carlos Rojas", mes="todo", limite=2)
    assert resultado["total"] == 6 and len(resultado["filas"]) == 2
    assert resultado["filas"][0]["nic"]
    assert filtro.capas == ["gps"]


def test_filtrar_mapa_vacio_se_rechaza(runner):
    resultado, filtro = correr(runner, "filtrar_mapa")
    assert resultado["error"] == "filtro_vacio" and filtro is None


def test_herramienta_inventada_no_llega_a_ningun_metodo(runner):
    resultado, _ = correr(runner, "__init__")
    assert "desconocida" in resultado["error"]


def test_la_pantalla_se_hereda_salvo_que_se_pida_otra_cosa(datos_dir):
    runner = ToolRunner(MetricsService(datos_dir), VistaTablero(zona="C15", meses=["2026-09"]))
    heredada, _ = correr(runner, "efectividad")
    assert heredada["metricas"]["tot"] == 2 and heredada["filtros_de_pantalla"]["zona"] == "C15"
    otra, _ = correr(runner, "efectividad", zona="C08")
    assert otra["metricas"]["tot"] == 1
    # Sin los filtros de pantalla se quita la zona, pero el periodo del tablero se conserva.
    sin, _ = correr(runner, "efectividad", sin_filtros_de_pantalla=True)
    assert sin["metricas"]["tot"] == 6


def test_ranking_por_zona_ignora_la_zona_de_la_pantalla(datos_dir):
    runner = ToolRunner(MetricsService(datos_dir), VistaTablero(zona="C15"))
    resultado, _ = correr(runner, "ranking", dimension="zona", mes="todo", min_ordenes=1)
    assert len(resultado["filas"]) == 4


def test_la_zona_que_el_modelo_inventa_no_rompe_la_busqueda_del_barrio(runner):
    # «Crespo (C05)»: el barrio existe, pero en otra zona. Antes salía «no encontrado».
    resultado, filtro = correr(runner, "efectividad", mes="todo", barrio="La Boquilla (C09)")
    assert "error" not in resultado and resultado["metricas"]["tot"] == 6
    exacto, _ = correr(runner, "efectividad", mes="todo", barrio="La Boquilla (C01)")
    assert exacto["metricas"]["tot"] == 3


def test_un_barrio_con_comuna_y_zona_se_encuentra_por_su_nombre(runner):
    grupo = asyncio.run(runner._grupo("Olaya Herrera"))
    assert [c.bkey.rpartition(" | ")[2] for c in grupo] == [
        "OLAYA HERRERA (COM 5) (C07)", "OLAYA HERRERA (COM 6) (C07)"]
    con_zona_inventada = asyncio.run(runner._grupo("OLAYA HERRERA (C03)"))
    assert len(con_zona_inventada) == 2


def test_el_desglose_trae_una_fila_por_barrio_pedido_con_sus_zonas_sumadas(runner):
    resultado, _ = correr(runner, "efectividad", mes="todo", barrio=["Albornoz (C05)", "La Boquilla"])
    filas = {f["nombre"]: f["tot"] for f in resultado["detalle_por_barrio"]}
    # «La Boquilla» está en C01 (3 órdenes) y C02 (3): una sola fila de 6, no dos.
    assert filas == {"Albornoz (C05)": 6, "La Boquilla": 6}


def test_un_nombre_que_el_catalogo_parte_en_varios_barrios_se_avisa(runner):
    resultado, _ = correr(runner, "efectividad", mes="todo", barrio="La Boquilla")
    assert resultado["barrios_incluidos"] == {
        "La Boquilla": ["LA BOQUILLA (C01)", "LA BOQUILLA (C02)"]}
    assert "AVISA" in resultado["nota"]
    unico, _ = correr(runner, "efectividad", mes="todo", barrio="Albornoz")
    assert "barrios_incluidos" not in unico, "un solo barrio no necesita aviso"


def test_corregimiento_filtra_la_efectividad(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", corregimiento="la boquilla")
    assert resultado["metricas"]["tot"] == 6  # barrios 2 y 3
    assert "corregimiento La Boquilla" in resultado["base"]
    assert filtro.corregimiento == "La Boquilla"  # nombre canónico, listo para el tablero
    urbano, _ = correr(runner, "efectividad", mes="todo", corregimiento="Cabecera municipal")
    assert urbano["metricas"]["tot"] == 10


def test_corregimiento_se_cruza_con_zona(runner):
    resultado, _ = correr(runner, "efectividad", mes="todo", corregimiento="La Boquilla", zona="C01")
    assert resultado["metricas"]["tot"] == 3  # solo el barrio 2


def test_ranking_por_corregimiento(runner):
    resultado, _ = correr(runner, "ranking", dimension="corregimiento", mes="todo", min_ordenes=1)
    assert {f["nombre"]: f["tot"] for f in resultado["filas"]} == {"Cabecera municipal": 10, "La Boquilla": 6}
    assert "zona urbana" in resultado["nota"]


def test_corregimiento_inexistente_vuelve_como_dato(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", corregimiento="Narnia")
    assert filtro is None
    assert "corregimiento" in str(resultado)


def test_filtrar_mapa_con_corregimiento(runner):
    resultado, filtro = correr(runner, "filtrar_mapa", corregimiento="boquilla")
    assert filtro.corregimiento == "La Boquilla"
    assert resultado["aplicado"]["corregimiento"] == "La Boquilla"


def test_la_vista_con_corregimiento_se_hereda():
    vista = VistaTablero(corregimiento="La Boquilla")
    assert "corregimiento: La Boquilla" in vista.resumen()


def test_filtrar_mapa_con_estado_umbrales_y_capas(runner):
    resultado, filtro = correr(
        runner, "filtrar_mapa", estados=["perdida"], minimo_ordenes=5, umbral_hotspot=80,
        ajustada=False, capas=["calor", "poligonos_zonas"], capas_apagar=["marcadores"],
    )
    assert filtro.estados == ["perdida"]
    assert (filtro.minimo_ordenes, filtro.umbral_hotspot, filtro.ajustada) == (5, 80, False)
    assert filtro.capas == ["calor", "poligonos_zonas"] and filtro.capas_apagar == ["marcadores"]
    assert resultado["aplicado"]["ajustada"] is False  # false cuenta como valor, no como vacío


def test_filtrar_mapa_rechaza_valores_fuera_de_rango(runner):
    resultado, filtro = correr(runner, "filtrar_mapa", umbral_hotspot=500)
    assert filtro is None and "error" in resultado
    resultado, filtro = correr(runner, "filtrar_mapa", capas=["nave_espacial"])
    assert filtro is None and "error" in resultado


def test_ranking_de_los_n_mejores_tecnicos_los_deja_elegidos_en_el_tablero(runner):
    resultado, filtro = correr(runner, "ranking", dimension="tecnico", mes="todo", min_ordenes=1, limite=2)
    assert [f["nombre"] for f in resultado["filas"]] == filtro.tecnicos
    assert len(filtro.tecnicos) == 2
    _, sin_limite = correr(runner, "ranking", dimension="tecnico", mes="todo", min_ordenes=1)
    assert sin_limite is None or not sin_limite.tecnicos  # un listado general no marca a nadie


def test_varias_zonas_se_suman_y_se_envian_como_lista(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", zona=["zona 15", "C08"])
    assert resultado["metricas"]["tot"] == 10  # C15 (6) + C08 (4)
    assert filtro.zonas == ["C15", "C08"] and filtro.zona is None
    assert "zona C15, C08" in resultado["base"]


def test_varios_corregimientos_y_zonas_se_cruzan(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", corregimiento=["La Boquilla", "Cabecera municipal"])
    assert resultado["metricas"]["tot"] == 16
    assert filtro.corregimientos == ["La Boquilla", "Cabecera municipal"]
    cruce, _ = correr(runner, "efectividad", mes="todo", corregimiento=["La Boquilla"], zona=["C01", "C02"])
    assert cruce["metricas"]["tot"] == 6


def test_filtrar_mapa_con_varias_zonas_y_corregimientos(runner):
    resultado, filtro = correr(runner, "filtrar_mapa", zona=["zona 1", "c2"], corregimiento="boquilla")
    assert filtro.zonas == ["C01", "C02"] and filtro.zona is None
    assert filtro.corregimiento == "La Boquilla" and filtro.corregimientos is None
    assert resultado["aplicado"]["zonas"] == ["C01", "C02"]


def test_ranking_de_las_n_peores_zonas_las_deja_elegidas(runner):
    resultado, filtro = correr(runner, "ranking", dimension="zona", mes="todo", min_ordenes=1, limite=2)
    assert filtro.zonas == [f["nombre"] for f in resultado["filas"]] and len(filtro.zonas) == 2
    uno, f1 = correr(runner, "ranking", dimension="zona", mes="todo", min_ordenes=1, limite=1)
    assert f1.zona == uno["filas"][0]["nombre"] and f1.zonas is None
    _, corr = correr(runner, "ranking", dimension="corregimiento", mes="todo", min_ordenes=1, limite=2)
    assert sorted(corr.corregimientos) == ["Cabecera municipal", "La Boquilla"]
    _, tipo = correr(runner, "ranking", dimension="tipo_os", mes="todo", min_ordenes=1, limite=1)
    assert tipo.tipo_os in ("Ordenes de suspensión", "Reconexión Impagados")


def test_zona_inexistente_en_una_lista_vuelve_como_dato(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", zona=["C15", "C99"])
    assert filtro is None and "zona" in str(resultado)


def test_comparar_mas_de_dos_periodos(runner):
    resultado, _ = correr(runner, "comparar_periodos", periodos=["2026-08", "2026-09", "todo"], dimension="zona", min_ordenes=1)
    assert resultado["periodos"] == ["2026-08", "2026-09", "2026-08, 2026-09"]
    fila = resultado["filas"][0]
    assert len(fila["periodos"]) == 3 and len(fila["cambios_consecutivos_pp"]) == 2
    assert len(resultado["total"]["periodos"]) == 3
    solo_uno, _ = correr(runner, "comparar_periodos", periodos=["2026-08"])
    assert solo_uno["error"] == "faltan_periodos"


def test_comparar_mueve_el_mapa_a_las_entidades_que_muestra(runner):
    resultado, filtro = correr(runner, "comparar_periodos", dimension="zona", min_ordenes=1)
    assert filtro.zonas == [f["nombre"] for f in resultado["filas"]]
    assert filtro.meses == ["2026-08", "2026-09"]
    _, barrios = correr(runner, "comparar_periodos", dimension="barrio", min_ordenes=1, limite=2)
    assert len(barrios.barrios) == 2 and barrios.zonas is None
    _, total = correr(runner, "comparar_periodos", zona="C15")
    assert total.zona == "C15" and total.meses == ["2026-08", "2026-09"]
    _, causa = correr(runner, "comparar_periodos", dimension="causa", min_ordenes=1)
    assert causa.zona is None and causa.zonas is None  # la causa no se filtra en el tablero


def test_serie_de_varias_zonas_a_la_vez(runner):
    resultado, filtro = correr(runner, "serie_mensual", dimension="zona", zona=["C15", "C08"])
    assert {e["nombre"] for e in resultado["entidades"]} == {"C15", "C08"}
    c15 = next(e for e in resultado["entidades"] if e["nombre"] == "C15")
    assert [p["mes"] for p in c15["serie"]] == ["2026-08", "2026-09"]
    assert c15["tot"] == 6 and "variacion_primero_a_ultimo_pp" in c15
    assert sorted(filtro.zonas) == ["C08", "C15"]


def test_serie_por_tecnico_y_limite(runner):
    resultado, filtro = correr(runner, "serie_mensual", dimension="tecnico", limite=2)
    assert len(resultado["entidades"]) == 2 and resultado["total_entidades"] == 3
    assert filtro.tecnicos == [e["nombre"] for e in resultado["entidades"]]
    malo, _ = correr(runner, "serie_mensual", dimension="mes")
    assert "error" in malo


def test_barrio_dentro_de_una_zona_se_queda_con_esa_zona(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", barrio="La Boquilla", zona="C02")
    assert resultado["metricas"]["tot"] == 3  # solo LA BOQUILLA (C02), no las dos zonas
    assert filtro.barrio == "CARTAGENA DE INDIAS | LA BOQUILLA (C02)" and filtro.barrios is None
    assert "detalle_por_zona" not in resultado
    por_corr, _ = correr(runner, "efectividad", mes="todo", barrio="La Boquilla", corregimiento="La Boquilla")
    assert por_corr["metricas"]["tot"] == 6  # los dos son de ese corregimiento


def test_barrio_en_una_zona_donde_no_esta_vuelve_como_dato(runner):
    resultado, filtro = correr(runner, "efectividad", mes="todo", barrio="Albornoz", zona="C01")
    assert resultado["error"] == "barrio_fuera_de_zona" and filtro is None
    assert resultado["aparece_en"] == ["ALBORNOZ (C15)"]
    otra, f2 = correr(runner, "filtrar_mapa", barrio="Albornoz", zona="C01")
    assert otra["error"] == "barrio_fuera_de_zona" and f2 is None


def test_filtrar_mapa_con_barrio_y_zona_elige_solo_esa_zona(runner):
    resultado, filtro = correr(runner, "filtrar_mapa", barrio="La Boquilla", zona="C01")
    assert filtro.barrio == "CARTAGENA DE INDIAS | LA BOQUILLA (C01)" and filtro.barrios is None


def test_el_ranking_por_barrio_une_las_zonas_de_un_mismo_barrio(runner):
    resultado, _ = correr(runner, "ranking", dimension="barrio", mes="todo", min_ordenes=1, limite=20)
    filas = resultado["filas"]
    boquilla = [f for f in filas if "LA BOQUILLA" in f["nombre"]]
    # La Boquilla está en C01 (3 órdenes) y C02 (3): una sola fila de 6, sin zona en el nombre.
    assert len(boquilla) == 1 and boquilla[0]["tot"] == 6
    assert boquilla[0]["nombre"] == "CARTAGENA DE INDIAS | LA BOQUILLA"
