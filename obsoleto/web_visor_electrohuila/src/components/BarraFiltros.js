"use client";

/**
 * La barra de arriba: identidad, filtros y utilidades.
 *
 * Los filtros son píldoras (ver `FiltroPildora`): cada una lleva su estado
 * dentro, así que no hace falta una fila de chips aparte repitiendo lo elegido.
 * El selector de meses es multi-selección y conserva su propia lista de
 * casillas; solo el disparador se viste de píldora como los demás.
 *
 * Los rótulos de los filtros salen de `dim.etiquetas`, que arma el ETL: así la
 * interfaz no tiene que saber qué columna de Acuacar hay detrás de cada
 * dimensión.
 */

import React from "react";
import { AlertTriangle, ChevronDown, Moon, RefreshCw, Sun, X } from "lucide-react";

import { useTheme } from "@/lib/tema";
import FiltroPildora from "@/components/FiltroPildora";

/**
 * Cuántos días tienen los datos que se están viendo.
 *
 * Se mide contra `meta.generated` —cuándo los generó el ETL— y no contra el
 * último refresco: pulsar el botón y que diga «actualizado hace 1 minuto» sería
 * mentir, porque las cifras pueden seguir siendo de hace una semana.
 */
function edadDeLosDatos(generated) {
  if (!generated) return null;
  const gen = new Date(`${generated}T00:00:00`);
  if (isNaN(gen.getTime())) return null;

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const dias = Math.round((hoy.getTime() - gen.getTime()) / 86400000);
  const exacta = gen.toLocaleDateString("es-CO", {
    day: "numeric", month: "long", year: "numeric"
  });

  if (dias <= 0) return { txt: "Hoy", exacta, alerta: false };
  if (dias === 1) return { txt: "Ayer", exacta, alerta: false };
  return { txt: `Hace ${dias} días`, exacta, alerta: true };
}

/** «2026-01-01» → «01 ene». En la barra el año sobra. */
function diaCorto(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" }).replace(".", "");
}

export default function BarraFiltros({
  st,
  dim,
  avail,
  onFilterChange,
  onReset,
  availableMonths,
  loadingMonths = [],
  onRefresh,
  refreshing = false,
  refreshResult = null
}) {
  const { theme, toggle } = useTheme();
  const et = dim.etiquetas || {};

  const [mesesAbiertos, setMesesAbiertos] = React.useState(false);
  const cajaMeses = React.useRef(null);

  const nombreMes = (key) => key.split(" de ")[0];
  const activos = st.months || [];
  const total = availableMonths.length;
  const ordenados = availableMonths.filter((m) => activos.includes(m.key));
  const cuantos = ordenados.length;
  const todos = total > 0 && cuantos === total;

  let resumen;
  if (todos || cuantos === 0) resumen = "Todos los meses";
  else if (cuantos <= 2) resumen = ordenados.map((m) => nombreMes(m.key)).join(" · ");
  else resumen = `${nombreMes(ordenados[0].key)} – ${nombreMes(ordenados[cuantos - 1].key)}`;

  const alternarMes = (key) => {
    if (activos.includes(key)) {
      if (cuantos <= 1) return; // nunca dejar cero meses
      onFilterChange("months", activos.filter((x) => x !== key));
    } else {
      onFilterChange("months", [...activos, key]);
    }
  };

  const atajo = todos ? "Solo el último" : "Todos";
  const aplicarAtajo = () => {
    if (todos) {
      const ultimo = availableMonths[total - 1];
      if (ultimo) onFilterChange("months", [ultimo.key]);
    } else {
      onFilterChange("months", availableMonths.map((m) => m.key));
    }
  };

  React.useEffect(() => {
    if (!mesesAbiertos) return;
    const fuera = (e) => {
      if (!cajaMeses.current?.contains(e.target)) setMesesAbiertos(false);
    };
    const esc = (e) => e.key === "Escape" && setMesesAbiertos(false);
    document.addEventListener("mousedown", fuera, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fuera, true);
      document.removeEventListener("keydown", esc);
    };
  }, [mesesAbiertos]);

  // Los meses solo cuentan como filtro puesto si no son los de arranque: el
  // visor abre con el mes en curso y marcarlo cada sesión sería ruido.
  const mesesPorDefecto = React.useMemo(() => {
    const reciente = availableMonths.find((m) => m.recent);
    return reciente ? [reciente.key] : availableMonths.map((m) => m.key);
  }, [availableMonths]);
  const mesesPuestos =
    cuantos > 0 &&
    (cuantos !== mesesPorDefecto.length || !mesesPorDefecto.every((k) => activos.includes(k)));

  // Solo se ofrecen las opciones que el resto de filtros deja con datos: elegir
  // una que devuelve cero registros no le sirve a nadie.
  const opcionesDe = (nombres, disponibles) =>
    nombres
      .map((texto, i) => ({ valor: i, texto }))
      .filter((o) => disponibles.has(o.valor));

  // Nombre del barrio seleccionado en el mapa (los barrios vienen como
  // "Municipio | Barrio"). Null si no hay ninguno elegido.
  const unidadSel = st.selUnidad == null
    ? null
    : (dim.barrios[st.selUnidad] || "").split(" | ").pop();
  const etiquetaUnidad = et.unidad || "Barrio";

  const hayFiltros =
    st.zona !== "" || st.muni !== "" || st.brig !== "" || st.tipo !== "" ||
    st.oper !== "" || st.activ !== "" || mesesPuestos || unidadSel;

  const edad = edadDeLosDatos(st.generated);
  const estadoRefresco =
    refreshResult === "error" ? "No se pudo actualizar" : edad?.txt || "";

  return (
    <header id="top">
      <div className="hd-id">
        <div className="hd-badge" aria-hidden="true">AC</div>
        <div className="hd-title">
          <b>Mapa de calor</b>
          <span>Acuacar · suspensiones</span>
        </div>

        <div className="hd-ctx">
          {dim.munis.length.toLocaleString("es-CO")} barrios ·{" "}
          {st.totalLoaded.toLocaleString("es-CO")} registros cargados ·{" "}
          {diaCorto(st.fechaMin)} – {diaCorto(st.fechaMax)}
        </div>

        <div className="hd-filtros">
          <FiltroPildora
            etiqueta={et.unidadPadre || "Zona"}
            valor={st.zona}
            opciones={opcionesDe(dim.zonas, avail.zona)}
            onElegir={(v) => onFilterChange("zona", v)}
            vacio={`Todas las zonas (${avail.zona.size})`}
          />
          <FiltroPildora
            etiqueta={et.unidad || "Barrio"}
            valor={st.muni}
            opciones={opcionesDe(dim.munis, avail.muni)}
            onElegir={(v) => onFilterChange("muni", v)}
            vacio={`Todos los barrios (${avail.muni.size})`}
          />
          <FiltroPildora
            etiqueta={et.brigs || "Proceso"}
            valor={st.brig}
            opciones={opcionesDe(dim.brigs, avail.brig)}
            onElegir={(v) => onFilterChange("brig", v)}
            vacio={`Todos los procesos (${avail.brig.size})`}
          />
          {dim.actividades && dim.actividades.length > 1 && (
            <FiltroPildora
              etiqueta={et.actividades || "Actividad"}
              valor={st.activ}
              opciones={opcionesDe(dim.actividades || [], avail.activ)}
              onElegir={(v) => onFilterChange("activ", v)}
              vacio={`Todas las actividades (${avail.activ.size})`}
            />
          )}
          {dim.operaciones && dim.operaciones.length > 1 && (
            <FiltroPildora
              etiqueta={et.operaciones || "Operación"}
              valor={st.oper}
              opciones={opcionesDe(dim.operaciones || [], avail.oper)}
              onElegir={(v) => onFilterChange("oper", v)}
              vacio={`Todas las operaciones (${avail.oper.size})`}
            />
          )}
          {dim.tipos && dim.tipos.length > 1 && (
            <FiltroPildora
              etiqueta={et.tipos || "Clase de servicio"}
              valor={st.tipo}
              opciones={opcionesDe(dim.tipos, avail.tipo)}
              onElegir={(v) => onFilterChange("tipo", v)}
              vacio={`Todas las clases (${avail.tipo.size})`}
            />
          )}

          <div className="hd-f" ref={cajaMeses}>
            <button
              type="button"
              className={`hd-pill ${mesesPuestos ? "on" : ""}`}
              aria-haspopup="dialog"
              aria-expanded={mesesAbiertos}
              onClick={() => setMesesAbiertos((v) => !v)}
            >
              <span className="hd-pill-k">Meses</span>
              <span className="hd-pill-v">: {resumen}</span>
              <span className="hd-pill-n">{cuantos}/{total}</span>
              <span className="hd-pill-ic" aria-hidden="true">
                <ChevronDown size={13} strokeWidth={2.4} />
              </span>
            </button>

            {mesesAbiertos && (
              <div className="mm-pop">
                <div className="mm-head">
                  <span className="mm-title">Selecciona meses</span>
                  <button type="button" className="mm-all" onClick={aplicarAtajo}>
                    {atajo}
                  </button>
                </div>
                <div className="mm-grid">
                  {availableMonths.map((m) => {
                    const on = activos.includes(m.key);
                    const bajando = loadingMonths.includes(m.key);
                    return (
                      <label
                        key={m.key}
                        className={`mm-item ${on ? "on" : ""}`}
                        title={m.recent ? "Mes en curso" : bajando ? "Descargando…" : undefined}
                      >
                        <input type="checkbox" checked={on} onChange={() => alternarMes(m.key)} />
                        <span className="mm-name">{nombreMes(m.key)}</span>
                        {bajando
                          ? <span className="mm-spin" aria-label="Descargando" />
                          : <span className="mm-n">{(m.n || 0).toLocaleString("es-CO")}</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* El municipio remarcado llega desde el mapa, no de un desplegable;
              aquí se ve que está puesto y se puede soltar. */}
          {unidadSel && (
            <div className="hd-f">
              <button
                type="button"
                className="hd-pill on"
                onClick={() => onFilterChange("selUnidad", null)}
                aria-label={`Quitar el filtro de ${unidadSel}`}
              >
                <span className="hd-pill-k">{etiquetaUnidad}</span>
                <span className="hd-pill-v">: {unidadSel}</span>
                <span className="hd-pill-ic" aria-hidden="true">
                  <X size={13} strokeWidth={2.4} />
                </span>
              </button>
            </div>
          )}

          {hayFiltros && (
            <button type="button" className="hd-clear" onClick={onReset}>
              Limpiar
            </button>
          )}
        </div>

        {estadoRefresco && (
          <span
            className={`hd-fresh ${refreshResult === "error" || edad?.alerta ? "warn" : ""}`}
            title={edad ? `Datos generados el ${edad.exacta}` : undefined}
            aria-live="polite"
          >
            {(refreshResult === "error" || edad?.alerta) && (
              <AlertTriangle size={14} strokeWidth={2.2} aria-hidden="true" />
            )}
            {estadoRefresco}
          </span>
        )}

        {onRefresh && (
          <button
            type="button"
            className="hd-ico"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Actualizar datos"
            title="Actualizar información"
          >
            <span className={`refresh-ic ${refreshing ? "spinning" : ""}`} aria-hidden="true">
              <RefreshCw size={16} strokeWidth={2.2} />
            </span>
          </button>
        )}

        <button
          type="button"
          className="hd-ico"
          onClick={toggle}
          aria-pressed={theme === "light"}
          aria-label={theme === "light" ? "Cambiar a tema oscuro" : "Cambiar a tema claro"}
          title={theme === "light" ? "Cambiar a tema oscuro" : "Cambiar a tema claro"}
        >
          <span aria-hidden="true">
            {theme === "light"
              ? <Sun size={16} strokeWidth={2.2} />
              : <Moon size={16} strokeWidth={2.2} />}
          </span>
        </button>
      </div>
    </header>
  );
}
