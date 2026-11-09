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
    assert "detalle_por_barrio" in resultado


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
